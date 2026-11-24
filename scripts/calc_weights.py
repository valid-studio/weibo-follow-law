#!/usr/bin/env python3
"""
Weibo Follow Law - Feature Screening, Dual-Source Weight Calibration, and Scoring Reference Script.

Zero external dependencies (Python 3 standard library only).
Privacy note: All inputs and outputs should use anonymized sample IDs. Built-in --demo mode uses
100% synthetic placeholder identifiers.

Input JSON schema (--input):
{
  "targets": [
    { "id": "demo_target_1", "friends_count": 420, "following": ["demo_kol_a", "demo_kol_b"] }
  ],
  "baselines": [
    { "id": "demo_baseline_1", "friends_count": 310, "following": ["demo_utility_bot"] }
  ],
  "accounts_meta": {
    "demo_kol_a": { "name": "demo_kol_a", "category": "politics", "followers_count": 650000 },
    "demo_utility_bot": { "name": "demo_utility_bot", "category": "utility", "followers_count": 15000000 }
  }
}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

VALID_CATEGORIES = ("politics", "social", "tech_acg", "stock", "military", "overseas")

SENSITIVITY_PRESETS: Dict[str, Dict[str, float]] = {
    "loose": {"warn": 3.9, "high": 5.6, "max_pages": 7},
    "standard": {"warn": 3.1, "high": 4.7, "max_pages": 9},
    "strict": {"warn": 2.5, "high": 4.1, "max_pages": 10},
}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def logit(p: float) -> float:
    p_safe = clamp(p, 1e-6, 1.0 - 1e-6)
    return math.log(p_safe / (1.0 - p_safe))


def follower_powerlaw_floor(
    followers_count: int,
    c0: float = 0.015,
    f_ref: float = 1_000_000.0,
    gamma: float = 0.70,
    f_min: float = 10_000.0,
    p_min: float = 0.005,
    p_cap: float = 0.50,
) -> float:
    """
    Compute prior population follow-rate lower bound from follower count F_i.
    Prevents finite-sample baseline undercounting of mega-accounts.
    """
    eff_followers = max(float(followers_count or 0), f_min)
    raw = c0 * ((eff_followers / f_ref) ** gamma)
    return clamp(raw, p_min, p_cap)


def extract_following_ids(sample: Dict[str, Any]) -> Set[str]:
    seen: Set[str] = set()
    for item in sample.get("following", []) or []:
        if isinstance(item, str):
            val = item.strip()
            if val:
                seen.add(val)
        elif isinstance(item, dict):
            val = str(item.get("id") or item.get("uid") or item.get("name") or "").strip()
            if val:
                seen.add(val)
    return seen


def calibrate_feature_weights(
    dataset: Dict[str, Any],
    *,
    alpha: float = 0.5,
    min_target_count: int = 3,
    min_target_rate: float = 0.08,
    baseline_exclusion_rate: float = 0.25,
    min_net_enrichment: float = 0.04,
    lor_scale: float = 0.38,
    min_weight: float = 0.15,
    max_weight: float = 1.28,
) -> Dict[str, Any]:
    """
    Screen candidate feature accounts and compute dual-source calibrated weights.
    """
    targets = dataset.get("targets", []) or []
    baselines = dataset.get("baselines", []) or []
    accounts_meta = dataset.get("accounts_meta", {}) or {}

    n_target = len(targets)
    n_baseline = len(baselines)
    if n_target == 0 or n_baseline == 0:
        raise ValueError("Dataset must contain non-empty 'targets' and 'baselines' arrays.")

    target_counts: Counter[str] = Counter()
    baseline_counts: Counter[str] = Counter()

    for sample in targets:
        for acc_id in extract_following_ids(sample):
            target_counts[acc_id] += 1

    for sample in baselines:
        for acc_id in extract_following_ids(sample):
            baseline_counts[acc_id] += 1

    all_candidates = set(target_counts.keys()) | set(baseline_counts.keys())

    baseline_exclusions: List[Dict[str, Any]] = []
    feature_matrix: List[Dict[str, Any]] = []
    dropped_candidates = 0

    for acc_id in sorted(all_candidates):
        c_t = target_counts[acc_id]
        c_b = baseline_counts[acc_id]
        meta = accounts_meta.get(acc_id, {}) or {}
        name = str(meta.get("name") or acc_id)
        category = str(meta.get("category") or "politics")
        followers_count = int(meta.get("followers_count") or 100_000)
        is_utility = bool(meta.get("is_utility", False))

        raw_t_rate = c_t / n_target
        raw_b_rate = c_b / n_baseline

        p_t = (c_t + alpha) / (n_target + 2.0 * alpha)
        p_b_obs = (c_b + alpha) / (n_baseline + 2.0 * alpha)
        p_b_pop = follower_powerlaw_floor(followers_count)
        p_b_eff = max(p_b_obs, p_b_pop)
        net_enrichment = p_t - p_b_eff

        # Route universal utility / high-baseline public accounts into baseline exclusions
        if is_utility or raw_b_rate >= baseline_exclusion_rate or (c_t >= min_target_count and p_b_obs >= p_t):
            baseline_exclusions.append(
                {
                    "id": acc_id,
                    "name": name,
                    "target_count": c_t,
                    "target_rate": round(raw_t_rate, 4),
                    "baseline_count": c_b,
                    "baseline_rate": round(raw_b_rate, 4),
                    "reason": "utility_or_high_baseline",
                }
            )
            continue

        # Minimum target support & positive net enrichment check
        if c_t < min_target_count or raw_t_rate < min_target_rate or net_enrichment < min_net_enrichment:
            dropped_candidates += 1
            continue

        if category not in VALID_CATEGORIES:
            category = "politics"

        lor = logit(p_t) - logit(p_b_eff)
        if lor <= 0:
            dropped_candidates += 1
            continue

        # Support shrinkage gently damps very low target counts
        support_shrink = c_t / (c_t + 2.0)
        raw_weight = lor * lor_scale * (0.85 + 0.15 * support_shrink)
        weight = round(clamp(raw_weight, min_weight, max_weight), 2)

        feature_matrix.append(
            {
                "id": acc_id,
                "name": name,
                "category": category,
                "weight": weight,
                "followers_count": followers_count,
                "target_count": c_t,
                "target_rate": round(raw_t_rate, 4),
                "baseline_count": c_b,
                "baseline_rate": round(raw_b_rate, 4),
                "p_b_obs": round(p_b_obs, 4),
                "p_b_pop": round(p_b_pop, 4),
                "p_b_eff": round(p_b_eff, 4),
                "net_enrichment": round(net_enrichment, 4),
                "log_odds_ratio": round(lor, 4),
            }
        )

    feature_matrix.sort(key=lambda x: (-x["weight"], -x["net_enrichment"], x["id"]))
    baseline_exclusions.sort(key=lambda x: (-x["baseline_rate"], x["id"]))

    return {
        "summary": {
            "n_target": n_target,
            "n_baseline": n_baseline,
            "total_unique_candidates": len(all_candidates),
            "selected_features": len(feature_matrix),
            "baseline_exclusions": len(baseline_exclusions),
            "dropped_candidates": dropped_candidates,
        },
        "feature_matrix": feature_matrix,
        "baseline_exclusions": baseline_exclusions,
    }


def compute_probability_from_score(score: float, effective_hit_count: int) -> int:
    """Exact mirror of computeProbabilityFromScore in shared/radar_engine.js."""
    if effective_hit_count <= 0 or score <= 0:
        return 0
    p = 100.0 / (1.0 + math.exp(-1.35 * (score - 2.95)))
    return max(1, min(99, round(p)))


def evaluate_following(
    following_ids: Sequence[str],
    feature_matrix: Sequence[Dict[str, Any]],
    exclusion_ids: Set[str],
    *,
    friends_count: int = 200,
    preset: str = "standard",
    shared_viewer_ids: Optional[Set[str]] = None,
    strict_shared_exemption: bool = False,
    exempt_reason: str = "",
) -> Dict[str, Any]:
    """
    Exact Python mirror of evaluateFollowing() in shared/radar_engine.js (v1.5.5).
    """
    thresholds = SENSITIVITY_PRESETS.get(preset, SENSITIVITY_PRESETS["standard"])
    warn_th = thresholds["warn"]
    high_th = thresholds["high"]

    feature_map = {f["id"]: f for f in feature_matrix}
    shared_set = shared_viewer_ids or set()

    excluded_count = 0
    hits_by_id: Dict[str, Dict[str, Any]] = {}
    for acc_id in following_ids:
        if acc_id in exclusion_ids:
            excluded_count += 1
            continue
        feat = feature_map.get(acc_id)
        if not feat or acc_id in hits_by_id:
            continue
        shared = acc_id in shared_set
        w = float(feat["weight"])
        is_core = feat["category"] != "stock" and w >= 0.85
        shared_exempt = shared and (strict_shared_exemption or not is_core)
        hits_by_id[acc_id] = {
            "id": acc_id,
            "name": feat["name"],
            "category": feat["category"],
            "weight": w,
            "is_core": is_core,
            "effective_weight": 0.0 if shared_exempt else w,
            "shared_with_viewer": shared,
            "shared_exempt": shared_exempt,
        }

    hit_items = sorted(hits_by_id.values(), key=lambda x: -x["weight"])
    by_category: Dict[str, List[float]] = defaultdict(list)
    non_stock_cats: Set[str] = set()
    max_non_stock_weight = 0.0

    for item in hit_items:
        ew = item["effective_weight"]
        if ew <= 0:
            continue
        cat = item["category"]
        by_category[cat].append(ew)
        if cat != "stock":
            non_stock_cats.add(cat)
            if ew > max_non_stock_weight:
                max_non_stock_weight = ew

    core_sum = 0.0
    pan_sum = 0.0
    stock_sum = 0.0

    for cat, weights in by_category.items():
        weights.sort(reverse=True)
        if cat == "stock":
            mults = (1.0, 0.60, 0.35)
            sc = 0.0
            for idx, w in enumerate(weights):
                m = mults[idx] if idx < len(mults) else 0.20
                sc += w * m
            stock_sum = min(0.70, sc)
        else:
            for idx, w in enumerate(weights):
                m = 1.0 if idx < 2 else (0.82 if idx == 2 else 0.65)
                eff_w = w * m
                if w >= 0.85:
                    core_sum += eff_w
                else:
                    pan_sum += eff_w

    pan_total = pan_sum + stock_sum
    pan_effective = 1.85 * math.log(1.0 + pan_total / 1.85)
    raw_score = core_sum + pan_effective

    eff_friends = max(int(friends_count or 0), len(following_ids))
    denom = 1.0 + 0.28 * max(0.0, math.log(max(eff_friends, 150) / 350.0))
    # Asymmetric damping (v1.5.5): denom only damps pan-topic/stock layer, never dilutes core anchors
    score = (core_sum + pan_effective / denom) if (core_sum > 0 or pan_effective > 0) else 0.0

    # Specificity Gate
    if score > 0 and max_non_stock_weight < 0.78 and len(non_stock_cats) < 3:
        score = min(score, max(0.0, warn_th - 0.15))
    score = round(score, 2)

    effective_hit_count = sum(1 for item in hit_items if item["effective_weight"] > 0)
    if exempt_reason or effective_hit_count <= 0 or score <= 0:
        level = "none"
        probability = 0
    else:
        probability = compute_probability_from_score(score, effective_hit_count)
        if score >= high_th:
            level = "high"
        elif score >= warn_th:
            level = "warn"
        else:
            level = "low"

    return {
        "friends_count": eff_friends,
        "scanned_count": len(following_ids),
        "excluded_count": excluded_count,
        "matched_count": len(hit_items),
        "effective_hit_count": effective_hit_count,
        "core_sum": round(core_sum, 3),
        "pan_effective": round(pan_effective, 3),
        "denom": round(denom, 3),
        "raw_score": round(raw_score, 2),
        "score": score,
        "probability": probability,
        "level": level,
        "exempt_reason": exempt_reason,
    }


def build_synthetic_demo_dataset() -> Dict[str, Any]:
    """
    Build a 100% synthetic anonymized dataset using strictly fictional placeholder IDs.
    """
    accounts_meta = {
        "demo_utility_bot": {"name": "demo_utility_bot", "category": "utility", "followers_count": 30_000_000, "is_utility": True},
        "demo_tech_public": {"name": "demo_tech_public", "category": "tech_acg", "followers_count": 3_500_000},
        "demo_kol_politics_a": {"name": "demo_kol_politics_a", "category": "politics", "followers_count": 780_000},
        "demo_kol_politics_b": {"name": "demo_kol_politics_b", "category": "politics", "followers_count": 1_100_000},
        "demo_kol_overseas_a": {"name": "demo_kol_overseas_a", "category": "overseas", "followers_count": 520_000},
        "demo_kol_military_a": {"name": "demo_kol_military_a", "category": "military", "followers_count": 640_000},
        "demo_kol_social_a": {"name": "demo_kol_social_a", "category": "social", "followers_count": 1_800_000},
        "demo_mega_media": {"name": "demo_mega_media", "category": "politics", "followers_count": 22_000_000},
        "demo_stock_kol_1": {"name": "demo_stock_kol_1", "category": "stock", "followers_count": 420_000},
        "demo_stock_kol_2": {"name": "demo_stock_kol_2", "category": "stock", "followers_count": 510_000},
        "demo_stock_kol_3": {"name": "demo_stock_kol_3", "category": "stock", "followers_count": 380_000},
        "demo_noise_once": {"name": "demo_noise_once", "category": "social", "followers_count": 90_000},
    }

    targets: List[Dict[str, Any]] = []
    for i in range(1, 31):
        following = ["demo_utility_bot"]
        if i <= 14:
            following.append("demo_kol_politics_a")
        if i <= 11:
            following.append("demo_kol_overseas_a")
        if i <= 10:
            following.append("demo_kol_politics_b")
        if i <= 9:
            following.append("demo_kol_military_a")
        if i <= 8:
            following.append("demo_kol_social_a")
        if i <= 9:
            following.append("demo_mega_media")
        if i <= 8:
            following.append("demo_stock_kol_1")
        if i <= 7:
            following.append("demo_stock_kol_2")
        if i <= 6:
            following.append("demo_stock_kol_3")
        if i % 5 == 0:
            following.append("demo_tech_public")
        if i == 1:
            following.append("demo_noise_once")
        targets.append({"id": f"demo_target_{i:02d}", "friends_count": 380 + i * 10, "following": following})

    baselines: List[Dict[str, Any]] = []
    for j in range(1, 41):
        following = []
        if j <= 28:
            following.append("demo_utility_bot")
        if j <= 14:
            following.append("demo_tech_public")
        if j <= 4:
            following.append("demo_stock_kol_1")
        if j <= 3:
            following.append("demo_stock_kol_2")
        if j <= 3:
            following.append("demo_stock_kol_3")
        if j <= 2:
            following.append("demo_mega_media")
        if j == 1:
            following.append("demo_kol_social_a")
        baselines.append({"id": f"demo_baseline_{j:02d}", "friends_count": 260 + j * 15, "following": following})

    return {
        "targets": targets,
        "baselines": baselines,
        "accounts_meta": accounts_meta,
    }


def run_demo() -> None:
    dataset = build_synthetic_demo_dataset()
    result = calibrate_feature_weights(dataset)
    summary = result["summary"]
    features = result["feature_matrix"]
    exclusions = {x["id"] for x in result["baseline_exclusions"]}

    print("=== Weibo Follow Law: Calibration & Anti-False-Positive Demo (Synthetic Data) ===")
    print(
        f"Samples: Target N={summary['n_target']}, Baseline N={summary['n_baseline']} | "
        f"Selected Features={summary['selected_features']}, "
        f"Baseline Exclusions={summary['baseline_exclusions']}, "
        f"Dropped={summary['dropped_candidates']}\n"
    )

    print("1) Auto-identified Baseline Exclusions (excluded before scoring):")
    for ex in result["baseline_exclusions"]:
        print(
            f"   - {ex['name']:20s} | Target={ex['target_count']}/{summary['n_target']} ({ex['target_rate']:.1%}) "
            f"| Baseline={ex['baseline_count']}/{summary['n_baseline']} ({ex['baseline_rate']:.1%})"
        )

    print("\n2) Calibrated Feature Weights (Dual-source baseline + popularity debiasing):")
    header = f"   {'Account':20s} {'Cat':9s} {'T_rate':>7s} {'B_obs':>7s} {'B_pop':>7s} {'LOR':>6s} {'Weight':>6s}"
    print(header)
    print("   " + "-" * (len(header) - 3))
    for f in features:
        print(
            f"   {f['name']:20s} {f['category']:9s} {f['target_rate']:7.1%} "
            f"{f['p_b_obs']:7.1%} {f['p_b_pop']:7.1%} {f['log_odds_ratio']:6.2f} {f['weight']:6.2f}"
        )

    print("\n3) User Scoring & Anti-False-Positive Verification (Standard Thresholds: warn=3.1, high=4.7):")
    scenarios = [
        (
            "Scenario A: Ordinary user (utility + tech public + 1 mega media)",
            ["demo_utility_bot", "demo_tech_public", "demo_mega_media"],
            280,
        ),
        (
            "Scenario B: Retail stock trader (all 3 stock KOLs, 0 core anchors)",
            ["demo_stock_kol_1", "demo_stock_kol_2", "demo_stock_kol_3"],
            300,
        ),
        (
            "Scenario C: High-following passerby (friends=5000, 1 social + 1 mega media)",
            ["demo_kol_social_a", "demo_mega_media"],
            5000,
            None,
        ),
        (
            "Scenario D: High-following target with multi-core anchors (friends=2500, asymmetric damping)",
            [
                "demo_kol_politics_a",
                "demo_kol_politics_b",
                "demo_kol_overseas_a",
                "demo_kol_military_a",
                "demo_kol_social_a",
            ],
            2500,
            None,
        ),
        (
            "Scenario E: Shared-following stratification (viewer also follows 1 core + 1 pan)",
            [
                "demo_kol_politics_a",
                "demo_kol_politics_b",
                "demo_kol_overseas_a",
                "demo_kol_military_a",
                "demo_mega_media",
            ],
            360,
            {"demo_kol_politics_a", "demo_mega_media"},
        ),
    ]
    for item in scenarios:
        title, follow_list, friends_cnt = item[0], item[1], item[2]
        shared_ids = item[3] if len(item) > 3 else None
        ev = evaluate_following(
            follow_list,
            features,
            exclusions,
            friends_count=friends_cnt,
            shared_viewer_ids=shared_ids,
        )
        print(
            f"   - {title}\n"
            f"     hits={ev['effective_hit_count']} (excluded={ev['excluded_count']}), "
            f"core={ev['core_sum']}, pan_eff={ev['pan_effective']}, denom={ev['denom']}, "
            f"score={ev['score']}, level={ev['level']}, prob={ev['probability']}%"
        )


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Calibrate follow-list feature weights and verify anti-false-positive scoring."
    )
    parser.add_argument("--demo", action="store_true", help="Run built-in synthetic anonymized demonstration.")
    parser.add_argument("--input", type=str, help="Path to anonymized JSON dataset.")
    parser.add_argument("--output", type=str, help="Optional path to write calibrated JSON output.")
    parser.add_argument("--alpha", type=float, default=0.5, help="Jeffreys/Laplace smoothing alpha (default: 0.5).")
    parser.add_argument("--min-target-count", type=int, default=3, help="Minimum target occurrences (default: 3).")
    parser.add_argument("--min-target-rate", type=float, default=0.08, help="Minimum target rate (default: 0.08).")
    parser.add_argument(
        "--baseline-exclusion-rate",
        type=float,
        default=0.25,
        help="Baseline rate above which accounts move to exclusions (default: 0.25).",
    )
    parser.add_argument(
        "--min-net-enrichment",
        type=float,
        default=0.04,
        help="Minimum net enrichment (p_T - p_B_eff) to retain feature (default: 0.04).",
    )
    parser.add_argument("--lor-scale", type=float, default=0.38, help="Log-odds ratio scaling factor (default: 0.38).")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if args.demo or not args.input:
        if not args.demo and not args.input:
            print("Tip: pass --demo for synthetic demo or --input <file.json> for custom data.\n", file=sys.stderr)
        run_demo()
        return 0

    input_path = Path(args.input)
    dataset = json.loads(input_path.read_text(encoding="utf-8"))
    result = calibrate_feature_weights(
        dataset,
        alpha=args.alpha,
        min_target_count=args.min_target_count,
        min_target_rate=args.min_target_rate,
        baseline_exclusion_rate=args.baseline_exclusion_rate,
        min_net_enrichment=args.min_net_enrichment,
        lor_scale=args.lor_scale,
    )

    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(payload + "\n", encoding="utf-8")
        print(f"Calibrated output written to {args.output}")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
