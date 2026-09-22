-- ===========================================================
-- GhostStackPoker — schema-v8-presence.sql
-- Fase 7.5: sistema de presença/AFK e cadeia automática de Host.
-- Roda em cima de tudo que já existe, sem apagar nada. Cole no SQL
-- Editor do Supabase e clique em Run.
-- ===========================================================

-- Última vez que o jogador mandou um "sinal de vida" (heartbeat) —
-- gravado a cada ~15s pelo próprio navegador enquanto a aba está
-- visível. Não existe coluna "is_afk": AFK é sempre CALCULADO a
-- partir disso (agora - last_seen_at > 2:30), nunca guardado como um
-- segundo estado que poderia ficar dessincronizado do real.
alter table players add column if not exists last_seen_at timestamptz not null default now();

-- Acelera a checagem periódica que todo cliente faz (ainda que a
-- tabela seja pequena numa mesa caseira, não custa nada indexar).
create index if not exists players_last_seen_at_idx on players (last_seen_at);
