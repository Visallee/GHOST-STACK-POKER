-- ===========================================================
-- GhostStackPoker — schema-v3-room-code.sql
-- Migração aditiva: separa o identificador interno da sala (rooms.id,
-- que NUNCA muda e é o que conecta jogadores/Realtime) do código
-- público de 6 letras (rooms.join_code, que o Host pode regenerar a
-- qualquer momento como medida anti-troll).
-- Rode isso no SQL Editor do Supabase.
-- ===========================================================

alter table rooms add column if not exists join_code text;

-- Preenche o join_code das salas já existentes com o próprio id
-- (que até agora era, na prática, o próprio código da sala).
update rooms set join_code = id where join_code is null;

alter table rooms alter column join_code set not null;

-- Garante que dois códigos públicos nunca coincidam (mesmo com salas
-- diferentes por baixo dos panos).
alter table rooms add constraint rooms_join_code_unique unique (join_code);
