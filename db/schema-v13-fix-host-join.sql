-- ===========================================================
-- GhostStackPoker — schema-v13-fix-host-join.sql
-- Libera o Host (Assento 1) para entrar na sala durante o 
-- status de "configuring"
-- ===========================================================

create or replace function join_room_secure(
  p_room_code text,
  p_name text
) returns json language plpgsql security definer set search_path = public as $$
declare
  v_next_seat integer;
  v_new_player record;
  v_room record;
  v_is_host boolean;
  v_sitting_out boolean;
begin
  -- 1. Bloqueia a sala para impedir conflitos
  select * into v_room from rooms where id = p_room_code for update;
  
  if not found then
    raise exception 'Sala não encontrada.';
  end if;

  -- 2. Descobre qual será o assento da pessoa tentando entrar
  select coalesce(max(seat_number), 0) + 1 into v_next_seat
  from players
  where room_code = p_room_code;

  -- 3. REGRA CORRIGIDA: Só barra a entrada se a sala NÃO estiver aberta 
  -- E a pessoa NÃO for o Host (ou seja, assento > 1).
  if v_room.status != 'open' and v_next_seat > 1 then
    raise exception 'A sala não está aberta para novos jogadores.';
  end if;

  -- 4. Primeiro a entrar é Host automático, os outros não.
  if v_next_seat = 1 then
     v_is_host := true;
  else
     v_is_host := false;
  end if;

  -- 5. Se a mão começou, o jogador fica de fora obrigatoriamente
  if v_room.hand_state != 'no_hand' then
     v_sitting_out := true;
  else
     v_sitting_out := false;
  end if;

  -- 6. O servidor define o saldo inicial e o status, o cliente não pode trapacear
  insert into players (room_code, name, chips, is_host, seat_number, sitting_out)
  values (p_room_code, p_name, v_room.starting_chips, v_is_host, v_next_seat, v_sitting_out)
  returning * into v_new_player;

  return row_to_json(v_new_player);
end;
$$;