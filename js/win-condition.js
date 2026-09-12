// ===========================================================
// GhostStackPoker — js/win-condition.js
// Lógica pura de fim de jogo: decide se a partida acabou (Mata-mata ou
// Limite de Rodadas) e monta o snapshot do pódio pro Lobby. Nenhuma
// função aqui toca no DOM ou no Supabase.
// ===========================================================

// players: linhas de "players" JÁ com os saldos atualizados da última
// mão (chips e is_eliminated recalculados antes de chamar isto).
// room: precisa de win_condition, round_limit, current_round.
//
// Devolve { finished: boolean }.
export function evaluateWinCondition(players, room) {
  if (room.win_condition === 'round_limit') {
    const limit = room.round_limit;
    if (typeof limit === 'number' && room.current_round >= limit) {
      return { finished: true };
    }
    return { finished: false };
  }

  // Modo 'elimination' (padrão): acaba quando sobra 1 jogador (ou 0,
  // caso extremo de todo mundo zerar na mesma mão) ainda não eliminado.
  const stillIn = players.filter(function (p) { return !p.is_eliminated; });
  return { finished: stillIn.length <= 1 };
}

// Monta o ranking final (pódio) a partir dos jogadores da sala.
// No modo Mata-mata, quem sobrevive fica em 1º; os eliminados são
// ordenados por "durou mais tempo" (eliminated_at mais recente = melhor
// colocação). No modo Limite de Rodadas, é só por saldo de fichas.
export function buildFinalResults(players, winCondition) {
  let sorted;

  if (winCondition === 'round_limit') {
    sorted = players.slice().sort(function (a, b) { return b.chips - a.chips; });
  } else {
    const survivors = players
      .filter(function (p) { return !p.is_eliminated; })
      .sort(function (a, b) { return b.chips - a.chips; });

    const eliminated = players
      .filter(function (p) { return p.is_eliminated; })
      .sort(function (a, b) {
        const at = a.eliminated_at ? new Date(a.eliminated_at).getTime() : 0;
        const bt = b.eliminated_at ? new Date(b.eliminated_at).getTime() : 0;
        return bt - at; // eliminado mais recentemente vem antes (durou mais)
      });

    sorted = survivors.concat(eliminated);
  }

  return sorted.map(function (p, index) {
    return { player_id: p.id, name: p.name, chips: p.chips, rank: index + 1 };
  });
}
