// ===========================================================
// GhostStackPoker — js/win-condition.js
// Lógica pura de fim de jogo.
// ===========================================================

export function evaluateWinCondition(players, room) {
  if (room.win_condition === "round_limit") {
    const limit = room.round_limit;
    if (typeof limit === "number" && room.current_round >= limit) {
      return { finished: true };
    }
    return { finished: false };
  }

  // Modo 'elimination' (padrão): ignora eliminados e "fantasmas" (left_room)
  const stillIn = players.filter(function (p) {
    return !p.is_eliminated && !p.left_room;
  });
  return { finished: stillIn.length <= 1 };
}

export function buildFinalResults(players, winCondition) {
  // Fantasmas não têm lugar no pódio
  const validPlayers = players.filter(function (p) {
    return !p.left_room;
  });
  let sorted;

  if (winCondition === "round_limit") {
    sorted = validPlayers.slice().sort(function (a, b) {
      return b.chips - a.chips;
    });
  } else {
    const survivors = validPlayers
      .filter(function (p) {
        return !p.is_eliminated;
      })
      .sort(function (a, b) {
        return b.chips - a.chips;
      });

    const eliminated = validPlayers
      .filter(function (p) {
        return p.is_eliminated;
      })
      .sort(function (a, b) {
        const at = a.eliminated_at ? new Date(a.eliminated_at).getTime() : 0;
        const bt = b.eliminated_at ? new Date(b.eliminated_at).getTime() : 0;
        return bt - at;
      });

    sorted = survivors.concat(eliminated);
  }

  return sorted.map(function (p, index) {
    return { player_id: p.id, name: p.name, chips: p.chips, rank: index + 1 };
  });
}
