// ===========================================================
// GhostStackPoker — js/betting-round.js
// ===========================================================

import { nextSeatInRing } from "./turn.js";

function getStillDecidingPlayers(players) {
  return players.filter(function (p) {
    return (
      !p.folded &&
      !p.is_eliminated &&
      !p.is_all_in &&
      !p.sitting_out &&
      p.chips > 0
    );
  });
}

export function getTableMaxBet(players) {
  return players.reduce(function (max, p) {
    return !p.folded && !p.sitting_out && p.current_bet > max
      ? p.current_bet
      : max;
  }, 0);
}

export function isReopeningAction(newActingBet, previousMaxBet) {
  return newActingBet > previousMaxBet;
}

export function applyActionToRound(
  players,
  actingPlayerId,
  newActingBet,
  previousMaxBet,
) {
  const reopens = isReopeningAction(newActingBet, previousMaxBet);

  return players.map(function (p) {
    if (p.id === actingPlayerId) {
      return Object.assign({}, p, {
        current_bet: newActingBet,
        has_acted_this_round: true,
      });
    }
    if (
      reopens &&
      !p.folded &&
      !p.is_eliminated &&
      !p.is_all_in &&
      !p.sitting_out &&
      p.chips > 0
    ) {
      return Object.assign({}, p, { has_acted_this_round: false });
    }
    return p;
  });
}

export function isBettingRoundClosed(players, tableMaxBet) {
  const stillDeciding = getStillDecidingPlayers(players);
  return stillDeciding.every(function (p) {
    return p.current_bet === tableMaxBet && p.has_acted_this_round === true;
  });
}

export function getNextSeatToAct(
  occupiedSeats,
  players,
  tableMaxBet,
  fromSeat,
) {
  const needsToAct = new Set(
    players
      .filter(function (p) {
        return (
          !p.folded &&
          !p.is_eliminated &&
          !p.is_all_in &&
          !p.sitting_out &&
          p.chips > 0 &&
          (p.current_bet < tableMaxBet || !p.has_acted_this_round)
        );
      })
      .map(function (p) {
        return p.seat_number;
      }),
  );

  if (needsToAct.size === 0) return null;

  let candidate = fromSeat;
  for (let i = 0; i < occupiedSeats.length; i++) {
    candidate = nextSeatInRing(occupiedSeats, candidate);
    if (candidate === null) return null;
    if (needsToAct.has(candidate)) return candidate;
  }
  return null;
}
