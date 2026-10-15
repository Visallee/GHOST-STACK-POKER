// ===========================================================
// GhostStackPoker — js/turn.js
// ===========================================================

export function getOccupiedSeats(players) {
  const seats = players
    .filter(function (p) {
      return !p.sitting_out;
    }) // Exclui a quarentena da roda base
    .map(function (p) {
      return p.seat_number;
    })
    .filter(function (n) {
      return typeof n === "number" && !Number.isNaN(n);
    });
  return Array.from(new Set(seats)).sort(function (a, b) {
    return a - b;
  });
}

export function getActiveSeats(players) {
  return players
    .filter(function (p) {
      return !p.folded && !p.is_eliminated && !p.sitting_out;
    })
    .map(function (p) {
      return p.seat_number;
    })
    .filter(function (n) {
      return typeof n === "number" && !Number.isNaN(n);
    })
    .sort(function (a, b) {
      return a - b;
    });
}

export function nextSeatInRing(occupiedSeatsSorted, fromSeat) {
  const n = occupiedSeatsSorted.length;
  if (n === 0) return null;
  if (n === 1) return occupiedSeatsSorted[0];

  let idx = occupiedSeatsSorted.indexOf(fromSeat);
  if (idx === -1) {
    idx = occupiedSeatsSorted.findIndex(function (s) {
      return s > fromSeat;
    });
    if (idx === -1) return occupiedSeatsSorted[0];
    return occupiedSeatsSorted[idx];
  }
  return occupiedSeatsSorted[(idx + 1) % n];
}

export function computeNextDealerSeat(occupiedSeats, previousDealerSeat) {
  if (occupiedSeats.length === 0) return null;
  if (previousDealerSeat === null || previousDealerSeat === undefined) {
    return occupiedSeats[0];
  }
  return nextSeatInRing(occupiedSeats, previousDealerSeat);
}

export function computeBlindSeats(occupiedSeats, dealerSeat) {
  if (
    occupiedSeats.length === 0 ||
    dealerSeat === null ||
    dealerSeat === undefined
  ) {
    return { smallBlindSeat: null, bigBlindSeat: null, firstToActSeat: null };
  }

  if (occupiedSeats.length === 1) {
    return {
      smallBlindSeat: dealerSeat,
      bigBlindSeat: dealerSeat,
      firstToActSeat: dealerSeat,
    };
  }

  if (occupiedSeats.length === 2) {
    const bigBlindSeat = nextSeatInRing(occupiedSeats, dealerSeat);
    return {
      smallBlindSeat: dealerSeat,
      bigBlindSeat: bigBlindSeat,
      firstToActSeat: dealerSeat,
    };
  }

  const smallBlindSeat = nextSeatInRing(occupiedSeats, dealerSeat);
  const bigBlindSeat = nextSeatInRing(occupiedSeats, smallBlindSeat);
  const firstToActSeat = nextSeatInRing(occupiedSeats, bigBlindSeat);
  return {
    smallBlindSeat: smallBlindSeat,
    bigBlindSeat: bigBlindSeat,
    firstToActSeat: firstToActSeat,
  };
}

export function getNextTurnSeat(occupiedSeats, activeSeats, fromSeat) {
  if (activeSeats.length === 0) return null;
  if (activeSeats.length === 1) return activeSeats[0];

  const activeSet = new Set(activeSeats);
  let candidate = fromSeat;

  for (let i = 0; i < occupiedSeats.length; i++) {
    candidate = nextSeatInRing(occupiedSeats, candidate);
    if (candidate === null) return null;
    if (activeSet.has(candidate)) return candidate;
  }
  return null;
}
