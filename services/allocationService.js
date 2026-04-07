/**
 * allocationService.js
 *
 * Advisory roll-allocation logic for sales orders.
 *
 * IMPORTANT: This service NEVER modifies roll status.
 * Allocations computed here are suggestions stored on the SO line.
 * Physical locking (status → "Allocated") happens at dispatch via rollService.
 */

"use strict";

const Roll = require("../models/Roll");

// ─── Constants ───────────────────────────────────────────────────────────────

const STANDARD_LENGTH = 1000; // metres; rolls of exactly this length are "standard"
const DEFAULT_TOLERANCE = 100; // accept result when remaining ≤ this value

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Sort rolls for greedy allocation:
 *   1. Standard rolls (length === STANDARD_LENGTH) first, FIFO order (oldest first)
 *   2. Non-standard rolls sorted by length DESC (longest usable remnants first)
 *
 * This maximises use of full-length rolls before dipping into odd lengths.
 */
function sortRollsForAllocation(rolls) {
  const standard = rolls
    .filter((r) => r.currentLengthMeters === STANDARD_LENGTH)
    .sort((a, b) => (a.inwardedAt || 0) - (b.inwardedAt || 0));

  const nonStandard = rolls
    .filter((r) => r.currentLengthMeters !== STANDARD_LENGTH)
    .sort((a, b) => b.currentLengthMeters - a.currentLengthMeters);

  return [...standard, ...nonStandard];
}

/**
 * Greedy pass: pick every roll whose full length fits within the remaining quota.
 * Rolls longer than remaining are skipped (paper rolls cannot be partially used).
 *
 * @param {Array}  rolls          - Sorted roll objects with currentLengthMeters
 * @param {number} requiredMeters
 * @param {number} tolerance      - Acceptable shortfall (default 100 m)
 * @returns {{ allocated, totalAllocated, remaining, fulfilled }}
 */
function greedyAllocate(rolls, requiredMeters, tolerance = DEFAULT_TOLERANCE) {
  let remaining = requiredMeters;
  const allocated = [];

  for (const roll of rolls) {
    if (remaining <= 0) break;
    if (roll.currentLengthMeters <= remaining) {
      allocated.push(roll);
      remaining -= roll.currentLengthMeters;
    }
  }

  return { allocated, remaining, fulfilled: remaining <= tolerance };
}

/**
 * Optimisation pass (bonus): if greedy leaves a small shortfall (≤ tolerance),
 * try swapping one or two of the last-allocated rolls for a slightly longer
 * unallocated roll that would cover the gap — with minimal over-allocation.
 *
 * @returns The best swap descriptor or null when no improvement is found.
 */
function findBestSwap(allRolls, allocated, remaining, tolerance) {
  const allocatedIds = new Set(allocated.map((r) => r._id.toString()));
  const unallocated = allRolls.filter((r) => !allocatedIds.has(r._id.toString()));

  let bestSwap = null;

  // Inspect the last 2 allocated rolls (disturbing earlier FIFO choices is wasteful)
  const candidateIndexes = [allocated.length - 1, allocated.length - 2].filter((i) => i >= 0);

  for (const i of candidateIndexes) {
    const toReplace = allocated[i];
    const neededLength = toReplace.currentLengthMeters + remaining;

    // Find the unallocated roll closest in length to neededLength (within 2× tolerance)
    const swap = unallocated.find(
      (r) =>
        r.currentLengthMeters >= neededLength &&
        r.currentLengthMeters <= neededLength + tolerance * 2
    );

    if (swap) {
      const gain = swap.currentLengthMeters - toReplace.currentLengthMeters;
      // Prefer the swap that covers the gap with the least over-allocation
      if (!bestSwap || gain < bestSwap.gain) {
        bestSwap = { replaceIndex: i, newRoll: swap, gain };
      }
    }
  }

  return bestSwap;
}

/**
 * Group an array of allocated roll objects into { lengthMeters, qty } buckets,
 * sorted by qty DESC then lengthMeters DESC for human-readable output.
 *
 * @param {Array} allocated
 * @returns {Array<{ lengthMeters: number, qty: number }>}
 */
function groupAllocation(allocated) {
  const map = {};
  for (const roll of allocated) {
    const len = roll.currentLengthMeters;
    map[len] = (map[len] || 0) + 1;
  }
  return Object.entries(map)
    .map(([lengthMeters, qty]) => ({ lengthMeters: Number(lengthMeters), qty }))
    .sort((a, b) => b.qty - a.qty || b.lengthMeters - a.lengthMeters);
}

// ─── DB fetch ────────────────────────────────────────────────────────────────

/**
 * Fetch all Mapped (available) rolls for a SKU and return them pre-sorted.
 * Uses .lean() for performance — we only need plain objects for the algorithm.
 */
async function fetchSortedRolls(skuId) {
  const rolls = await Roll.find({
    skuId,
    status: "Mapped",
    currentLengthMeters: { $gt: 0 },
  })
    .select("_id rollNumber currentLengthMeters inwardedAt")
    .lean();

  return sortRollsForAllocation(rolls);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the full allocation pipeline for a single order line.
 *
 * Steps:
 *   1. Fetch Mapped rolls for the SKU (sorted: standard first, then non-standard DESC)
 *   2. Greedy pass — pick rolls until quota met or inventory exhausted
 *   3. If remaining ≤ tolerance, try a small swap optimisation to close the gap
 *   4. Return groups, roll-level details, and summary metrics
 *
 * @param {string|ObjectId} skuId
 * @param {number}          requiredMeters
 * @param {number}          [tolerance=100]  Acceptable shortfall in metres
 *
 * @returns {Promise<AllocationResult>}
 *   AllocationResult = {
 *     status:               "FULFILLED" | "PARTIAL" | "NO_INVENTORY",
 *     groups:               [{ lengthMeters, qty }],   // bifurcation-compatible
 *     rollDetails:          [{ rollId, rollNumber, lengthMeters }],
 *     totalAllocatedMeters: number,
 *     remainingMeters:      number,
 *     fulfilled:            boolean,
 *   }
 */
async function autoAllocateForLine(skuId, requiredMeters, tolerance = DEFAULT_TOLERANCE) {
  if (!skuId || !requiredMeters || requiredMeters <= 0) return null;

  const rolls = await fetchSortedRolls(skuId);

  if (rolls.length === 0) {
    return {
      status: "NO_INVENTORY",
      groups: [],
      rollDetails: [],
      totalAllocatedMeters: 0,
      remainingMeters: requiredMeters,
      fulfilled: false,
    };
  }

  // ── Greedy pass ────────────────────────────────────────────────────────────
  const pass1 = greedyAllocate(rolls, requiredMeters, tolerance);
  let { allocated } = pass1;
  let { remaining } = pass1;

  // ── Swap optimisation (bonus) ──────────────────────────────────────────────
  // Only attempt if we have a gap that is small enough to potentially close
  if (remaining > 0 && remaining <= tolerance) {
    const swap = findBestSwap(rolls, allocated, remaining, tolerance);
    if (swap) {
      allocated = [...allocated];
      allocated.splice(swap.replaceIndex, 1, swap.newRoll);
      remaining -= swap.gain;
      if (remaining < 0) remaining = 0; // clamp — slight over-allocation is fine
    }
  }

  const totalAllocated = allocated.reduce((s, r) => s + r.currentLengthMeters, 0);
  const fulfilled = remaining <= tolerance;

  return {
    status: fulfilled ? "FULFILLED" : "PARTIAL",
    groups: groupAllocation(allocated),
    rollDetails: allocated.map((r) => ({
      rollId: r._id,
      rollNumber: r.rollNumber,
      lengthMeters: r.currentLengthMeters,
    })),
    totalAllocatedMeters: totalAllocated,
    remainingMeters: Math.max(0, remaining),
    fulfilled,
  };
}

module.exports = {
  autoAllocateForLine,
  // Exported for unit testing:
  allocateRolls: greedyAllocate,
  groupAllocation,
  sortRollsForAllocation,
};
