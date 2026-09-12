-- ===========================================================
-- GhostStackPoker — schema-v4-turn-order.sql
-- Migração aditiva: adiciona o controle de turnos (assentos fixos,
-- botão do Dealer e de quem tem a vez agora). Roda em cima de
-- schema.sql + schema-v2-host-config.sql + schema-v3-room-code.sql,
-- sem apagar nada. Cole no SQL Editor do Supabase e clique em Run.
-- ===========================================================

-- ---------- Assento fixo do jogador (independente de joined_at) ----------

alter table players add column if not exists seat_number integer;

-- Garante que dois jogadores da MESMA sala nunca dividam o mesmo
-- assento (jogadores de salas diferentes podem, claro, ter o mesmo
-- número — ex: assento 1 existe em toda sala).
create unique index if not exists players_room_seat_unique
  on players (room_code, seat_number);

-- ---------- Estado do turno na sala ----------

-- Assento que está com o botão do Dealer nesta mão. Começa null (sem
-- mão em andamento) até o Host clicar em "Iniciar Mão" pela primeira
-- vez.
alter table rooms add column if not exists dealer_seat integer;

-- Assento de quem tem a vez de agir AGORA. null = nenhuma mão em
-- andamento (mostra o botão "Iniciar Mão" pro Host).
alter table rooms add column if not exists current_turn_seat integer;

-- ---------- Observação sobre salas/jogadores já existentes ----------
-- Jogadores criados ANTES desta migração vão ficar com seat_number
-- NULL — eles não vão aparecer na rotação de turnos (getOccupiedSeats
-- ignora assentos nulos). Isso só afeta salas de teste antigas; salas
-- novas já atribuem o assento automaticamente em js/home.js.
