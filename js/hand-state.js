// ===========================================================
// GhostStackPoker — js/hand-state.js
// Nomes canônicos dos estados da mão/rodada (rooms.hand_state no
// banco). Um arquivo só com essas strings evita erro de digitação
// espalhado entre partida.js e os testes.
//
// CICLO OBRIGATÓRIO:
//
//   NO_HAND
//     -> (Host clica "Iniciar Mão")
//   WAITING_FOR_ANTE   <- ninguém pode agir ainda
//     -> (Host clica "Cobrar Antes")
//   BETTING            <- turnos liberados, motor de rodada ativo
//     -> (todo mundo igualou/desistiu/all-in)
//   ROUND_COMPLETE     <- ninguém tem a vez, aguardando o Host resolver
//     -> (Host clica "Entregar Pote")
//   WAITING_FOR_ANTE (de novo, pra próxima mão)
//     ... ou GAME_STATUS vira 'finished' se a condição de vitória bateu
// ===========================================================

export const HAND_STATE = {
  NO_HAND: 'no_hand',
  WAITING_FOR_ANTE: 'waiting_for_ante',
  BETTING: 'betting',
  ROUND_COMPLETE: 'round_complete'
};
