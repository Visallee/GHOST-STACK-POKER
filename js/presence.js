// ===========================================================
// GhostStackPoker — js/presence.js
// Funções puras do sistema de presença/AFK. Nenhuma função aqui toca
// no DOM, no Supabase, ou em relógio "de verdade" (sempre recebem
// "nowMs" de fora) — isso as torna 100% testáveis sem mock de tempo.
//
// COMO O SISTEMA FUNCIONA (sem servidor, só clientes):
// - Cada jogador manda um "heartbeat" (grava players.last_seen_at)
//   periodicamente enquanto a aba está visível.
// - Minimizar/trocar de aba PARA o heartbeat — é isso que começa a
//   contar o tempo de ausência.
// - Qualquer cliente conectado consegue calcular, a partir de
//   last_seen_at, se alguém está AFK — não precisa de um servidor
//   rodando o relógio.
// ===========================================================

// Tempo de ausência até ser expulso automaticamente: 2 minutos e 30s.
export const AFK_KICK_THRESHOLD_MS = 150000;

// Só começa a MOSTRAR o aviso/contador depois de passar um pouco do
// intervalo normal de heartbeat — evita mostrar "expulso em 2:29" pra
// todo mundo o tempo todo só por causa da folga natural entre um
// heartbeat e outro.
export const AFK_WARNING_THRESHOLD_MS = 20000;

// Quanto tempo falta pra expulsão automática (nunca negativo).
export function getAfkRemainingMs(lastSeenAt, nowMs) {
  if (!lastSeenAt) return 0;
  const elapsed = nowMs - new Date(lastSeenAt).getTime();
  return Math.max(0, AFK_KICK_THRESHOLD_MS - elapsed);
}

// Já passou dos 2:30 — deveria ser expulso.
export function isPlayerAfk(lastSeenAt, nowMs) {
  return getAfkRemainingMs(lastSeenAt, nowMs) <= 0;
}

// Já vale a pena MOSTRAR o contador vermelho pra esse jogador (mesmo
// que ainda não tenha batido os 2:30 de verdade).
export function shouldShowAfkWarning(lastSeenAt, nowMs) {
  if (!lastSeenAt) return false;
  const elapsed = nowMs - new Date(lastSeenAt).getTime();
  return elapsed > AFK_WARNING_THRESHOLD_MS;
}

// Formata milissegundos restantes como "2:15" (padrão de cronômetro).
export function formatCountdown(remainingMs) {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ':' + String(seconds).padStart(2, '0');
}

// Decide quem DEVERIA ser o próximo Host, entre os jogadores que NÃO
// estão AFK, na ordem de entrada (mais antigo primeiro — nunca
// aleatório). Devolve null se não sobrar ninguém elegível (caso
// extremo: todo mundo AFK ao mesmo tempo).
export function computeNextHostByJoinOrder(players, nowMs, excludePlayerId) {
  const eligible = players
    .filter(function (p) {
      return p.id !== excludePlayerId && !isPlayerAfk(p.last_seen_at, nowMs);
    })
    .sort(function (a, b) {
      return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
    });

  return eligible.length > 0 ? eligible[0].id : null;
}
