-- =====================================================================
-- Wanted — test de bout en bout côté base (éditeur SQL Supabase).
-- Simule un organisateur et 3 joueurs, puis efface toutes ses traces.
-- À lancer uniquement quand aucune vraie partie n'est en cours.
-- =====================================================================

create temp table if not exists _report(n serial, test text, ok boolean, detail text);
truncate _report;
-- Les vrais abonnements aux notifications sont mis de côté (la purge du test les efface) puis remis.
create temp table if not exists _subs as select * from public.push_subscriptions where false;
truncate _subs;
insert into _subs select * from public.push_subscriptions;

do $$
declare
  u_org uuid := gen_random_uuid();
  u uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  pid uuid[] := '{}';
  r json;
  st json;
  t_id uuid; h_id uuid; x_id uuid;
  v_code text;
  i int;
  v_err text;
  v_quest bigint;
  v_total int;
begin
  if (select status from public.games where id = 1) <> 'accueil'
     or exists (select 1 from public.assignments) then
    raise exception 'Une partie est en cours : test annulé';
  end if;

  -- Pas d'appel HTTP réel à la fonction d'envoi pendant le test.
  perform set_config('wanted.push_kicked', '1', true);

  -- Organisateur
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.claim_organizer((select org_code from public.games where id = 1));
  insert into _report(test, ok) values ('claim_organizer', public._is_org());

  begin
    perform public.claim_organizer('MAUVAIS');
    insert into _report(test, ok) values ('code organisateur faux refusé', false);
  exception when others then
    insert into _report(test, ok) values ('code organisateur faux refusé', true);
  end;

  for i in 1..3 loop
    r := public.org_create_player('__test_' || i);
    pid := pid || (r->>'id')::uuid;
  end loop;
  insert into _report(test, ok, detail) values ('3 joueurs créés', array_length(pid,1) = 3, null);
  -- Joueurs « inscrits » depuis 1 h, pour pouvoir simuler des pings passés.
  update public.players set created_at = now() - interval '1 hour' where id = any(pid);

  -- Chaque joueur se connecte avec son code d'accès
  for i in 1..3 loop
    perform set_config('request.jwt.claims', json_build_object('sub', u[i], 'role', 'authenticated')::text, true);
    perform public.claim_player(lower((select access_code from public.players where id = pid[i])));
  end loop;
  insert into _report(test, ok) values ('connexion des 3 joueurs (code en minuscules)',
    (select count(*) from public.devices where auth_uid = any(u) and player_id = any(pid)) = 3);

  -- Droits : un joueur ne peut pas lire les tables directement
  begin
    execute 'set local role authenticated';
    perform count(*) from public.players;
    execute 'reset role';
    insert into _report(test, ok) values ('lecture directe des tables bloquée', false);
  exception when insufficient_privilege then
    execute 'reset role';
    insert into _report(test, ok) values ('lecture directe des tables bloquée', true);
  end;

  -- Un joueur ne peut pas utiliser les fonctions organisateur
  begin
    perform public.org_reset();
    insert into _report(test, ok) values ('fonctions org refusées au joueur', false);
  exception when others then
    insert into _report(test, ok) values ('fonctions org refusées au joueur', true);
  end;

  -- Dispersion : pas de cible visible
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_start_dispersion(1);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  st := public.get_my_state();
  insert into _report(test, ok, detail) values ('dispersion : aucune cible',
    st->'game'->>'status' = 'dispersion' and json_typeof(st->'target') = 'null', st->'game'->>'status');

  -- Notifications : abonnement du joueur 1
  r := public.save_push_subscription('https://push.example.test/abc', 'cle', 'auth', 'test');
  st := public.get_my_state();
  insert into _report(test, ok, detail) values ('notif : abonnement enregistré',
    (st->'me'->>'push_devices')::int = 1, st->'me'->>'push_devices');
  begin
    perform public.save_push_subscription('http://pas-https', 'cle', 'auth', null);
    insert into _report(test, ok) values ('notif : abonnement invalide refusé', false);
  exception when others then
    insert into _report(test, ok) values ('notif : abonnement invalide refusé', true);
  end;
  insert into _report(test, ok) values ('notif : dispersion en file',
    exists (select 1 from public.push_jobs where kind = 'dispersion' and status = 'attente'));

  -- START forcé : tirage en boucle
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_draw_now();
  insert into _report(test, ok, detail) values ('tirage en boucle : 1 cible et 1 chasseur chacun',
    (select count(*) from public.assignments where closed_at is null and hunter_id = any(pid)) = 3
    and (select count(distinct target_id) from public.assignments where closed_at is null and hunter_id = any(pid)) = 3
    and not exists (select 1 from public.assignments where hunter_id = target_id),
    (select status from public.games where id = 1));
  insert into _report(test, ok, detail) values ('notif : START + 8 notifications de ping programmées',
    exists (select 1 from public.push_jobs where kind = 'start')
    and (select count(*) from public.push_jobs where kind = 'ping' and round = 1 and status = 'attente'
            and send_at > now()) = 8,
    (select count(*) from public.push_jobs where kind = 'ping')::text);

  -- Joueur 1 voit sa cible
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  st := public.get_my_state();
  select target_id into t_id from public.assignments where hunter_id = pid[1] and closed_at is null;
  insert into _report(test, ok, detail) values ('get_my_state renvoie la cible',
    st->'target'->>'pseudo' = (select pseudo from public.players where id = t_id), st->'target'->>'pseudo');
  insert into _report(test, ok, detail) values ('compteur : 1 chasseur après le tirage en boucle',
    (st->'me'->>'hunters')::int = 1, st->'me'->>'hunters');

  -- Sans « Wanted ! », impossible de saisir un code
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  select target_id into x_id from public.assignments where hunter_id = pid[2] and closed_at is null;
  r := public.submit_capture((select capture_code from public.players where id = x_id));
  insert into _report(test, ok, detail) values ('code refusé sans repérage', r->>'reason' = 'no_spot', r->>'reason');

  -- Repérage raté par 3 codes faux : cible immunisée, chasseur bloqué
  r := public.spot_target();
  insert into _report(test, ok, detail) values ('Wanted ! : repérage ouvert pour 1 min', (r->>'ok')::boolean, r::text);
  insert into _report(test, ok) values ('notif : alerte urgente à la cible avec son code',
    exists (select 1 from public.push_jobs where kind = 'repere' and player_id = x_id and urgent
              and body like '%' || (select capture_code from public.players where id = x_id) || '%'));
  perform set_config('request.jwt.claims', json_build_object('sub', u[array_position(pid, x_id)], 'role', 'authenticated')::text, true);
  st := public.get_my_state();
  insert into _report(test, ok) values ('la cible voit qu''elle est repérée', json_typeof(st->'spotted') = 'object');
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  v_code := lpad(((select capture_code from public.players where id = x_id)::int + 1) % 10000 || '', 4, '0');
  r := public.submit_capture(v_code);
  insert into _report(test, ok, detail) values ('1er code faux : encore 2 essais', (r->>'attempts_left')::int = 2, r::text);
  r := public.submit_capture(v_code);
  r := public.submit_capture(v_code);
  insert into _report(test, ok, detail) values ('3e code faux : repérage raté', r->>'reason' = 'failed', r::text);
  insert into _report(test, ok) values ('cible immunisée et chasseur bloqué 2 min',
    (select immune_until > now() + interval '100 seconds' from public.players where id = x_id)
    and (select cooldown_until > now() + interval '100 seconds' from public.players where id = pid[2]));
  r := public.spot_target();
  insert into _report(test, ok, detail) values ('Wanted ! bloqué pendant 2 min', r->>'reason' = 'cooldown', r->>'reason');
  insert into _report(test, ok) values ('notif : fausse alerte signalée à la cible',
    exists (select 1 from public.push_jobs where kind = 'repere_echoue' and player_id = x_id));

  -- Envoi : la fonction d'envoi récupère les notifications dues avec les abonnements
  r := public.claim_push_jobs();
  insert into _report(test, ok, detail) values ('notif : file prise avec destinataires',
    exists (select 1 from json_array_elements(r) e
             where e->>'kind' = 'dispersion' and json_array_length(e->'subs') = 1)
    and not exists (select 1 from json_array_elements(r) e where e->>'kind' = 'ping'),
    left(r::text, 180));
  perform public.finish_push_job((select min(id) from public.push_jobs where status = 'envoi'), '{}'::jsonb);
  perform public.drop_push_subscription('https://push.example.test/abc');
  insert into _report(test, ok) values ('notif : abonnement expiré supprimé',
    not exists (select 1 from public.push_subscriptions where endpoint = 'https://push.example.test/abc'));

  -- Capture réussie par le joueur 1
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  r := public.spot_target();
  v_code := (select capture_code from public.players where id = t_id);
  r := public.submit_capture(v_code);
  insert into _report(test, ok, detail) values ('capture réussie', (r->>'ok')::boolean, r::text);
  insert into _report(test, ok, detail) values ('scores +3 / −2',
    (select sum(points) from public.score_events where player_id = pid[1]) = 3
    and (select sum(points) from public.score_events where player_id = t_id) = -2, null);
  insert into _report(test, ok) values ('nouveau code et immunité pour la cible',
    (select capture_code <> v_code and immune_until > now() from public.players where id = t_id));
  insert into _report(test, ok, detail) values ('nouvelle cible du chasseur ≠ lui-même et ≠ cible trouvée',
    (select target_id not in (pid[1], t_id) from public.assignments where hunter_id = pid[1] and closed_at is null),
    (select p.pseudo from public.assignments a join public.players p on p.id = a.target_id
      where a.hunter_id = pid[1] and a.closed_at is null));

  -- Double envoi : le repérage est terminé
  r := public.submit_capture(v_code);
  insert into _report(test, ok, detail) values ('double envoi refusé', not (r->>'ok')::boolean, r->>'reason');

  -- Immunité : l'organisateur fait chasser la cible immunisée
  select id into h_id from public.players where id = any(pid) and id not in (pid[1], t_id);
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_reassign(h_id, t_id);
  update public.players set cooldown_until = null where id = h_id; -- au cas où ce joueur serait celui qui est bloqué
  perform set_config('request.jwt.claims', json_build_object('sub', u[array_position(pid, h_id)], 'role', 'authenticated')::text, true);
  r := public.spot_target();
  insert into _report(test, ok, detail) values ('cible immunisée : Wanted ! refusé', r->>'reason' = 'immune', r->>'reason');

  -- Plusieurs chasseurs sur la même cible : tous réattribués
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  update public.players set immune_until = null where id = t_id;
  perform public.org_reassign(pid[1], t_id);
  perform set_config('request.jwt.claims', json_build_object('sub', u[array_position(pid, h_id)], 'role', 'authenticated')::text, true);
  r := public.spot_target();
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  r := public.spot_target();
  insert into _report(test, ok, detail) values ('cible déjà repérée par un autre chasseur', r->>'reason' = 'already_spotted', r->>'reason');
  perform set_config('request.jwt.claims', json_build_object('sub', u[array_position(pid, h_id)], 'role', 'authenticated')::text, true);
  r := public.submit_capture((select capture_code from public.players where id = t_id));
  insert into _report(test, ok, detail) values ('2e capture : les 2 chasseurs de la cible sont réattribués',
    (r->>'ok')::boolean
    and not exists (select 1 from public.assignments where target_id = t_id and closed_at is null),
    r::text);

  -- Minute écoulée sans code : repérage raté automatiquement
  update public.players set immune_until = null, cooldown_until = null where id = any(pid);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  r := public.spot_target();
  select target_id into x_id from public.challenges where hunter_id = pid[1] and status = 'active';
  update public.challenges set expires_at = now() - interval '10 seconds' where hunter_id = pid[1] and status = 'active';
  st := public.get_my_state();
  insert into _report(test, ok, detail) values ('minute écoulée : cible immunisée, chasseur bloqué',
    (r->>'ok')::boolean
    and json_typeof(st->'spot') = 'null'
    and (st->'me'->>'locked_until') is not null
    and (select immune_until > now() from public.players where id = x_id),
    r::text);
  update public.players set immune_until = null, cooldown_until = null where id = any(pid);

  -- Lecture du classement et de la vue organisateur
  st := public.get_leaderboard();
  insert into _report(test, ok, detail) values ('classement', json_array_length(st) >= 3, st::text);
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  st := public.org_get_overview();
  insert into _report(test, ok) values ('vue organisateur', json_array_length(st->'players') >= 3);

  -- Annulation de capture
  perform public.org_cancel_capture((select max(id) from public.captures));
  insert into _report(test, ok) values ('annulation de capture rend les points',
    (select sum(points) from public.score_events where player_id = t_id) = -2);

  -- ===== Pings et positions =====
  insert into _report(test, ok, detail) values ('4 pings programmés au START (+15, +30, +40, +45)',
    (select count(*) from public.pings where round = 1 and kind in ('chasseur','general')) = 4,
    (select string_agg(kind || ' +' || extract(epoch from scheduled_at - (select start_at from public.games))::int / 60, ', ' order by scheduled_at)
       from public.pings where round = 1));

  insert into _report(test, ok, detail) values ('périmètre chargé', (select perimeter is not null from public.games where id = 1), null);
  insert into _report(test, ok, detail) values ('point au centre : dans le périmètre',
    (select inside from public._perimeter_check(46.5815, 0.3412)), null);
  insert into _report(test, ok, detail) values ('point éloigné : hors périmètre',
    (select not inside and dist_m > 500 from public._perimeter_check(46.5700, 0.3300)),
    (select round(dist_m) || ' m' from public._perimeter_check(46.5700, 0.3300)));

  -- Hors fenêtre : refusé
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  r := public.send_position(46.5815, 0.3412, 10);
  insert into _report(test, ok, detail) values ('envoi hors fenêtre refusé', r->>'reason' = 'no_window', r::text);

  -- Ping manuel à tous
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_request_position(null);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  st := public.get_my_state();
  insert into _report(test, ok, detail) values ('le joueur voit le ping ouvert',
    exists (select 1 from json_array_elements(st->'pings') e where e->>'kind' = 'manuel' and not (e->>'sent')::boolean), null);
  r := public.send_position(46.5815, 0.3412, 10);
  insert into _report(test, ok, detail) values ('position dans la zone acceptée', (r->>'ok')::boolean and not (r->>'out_of_perimeter')::boolean, r::text);
  r := public.send_position(46.5815, 0.3412, 10);
  insert into _report(test, ok, detail) values ('second envoi sans doublon', (r->>'already')::boolean, r::text);
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  r := public.send_position(46.5700, 0.3300, 20);
  insert into _report(test, ok, detail) values ('position hors zone signalée', (r->>'out_of_perimeter')::boolean, r::text);

  -- Visibilité : un ping manuel n'est pas montré aux chasseurs, sauf révélation
  insert into _report(test, ok) values ('ping manuel invisible des chasseurs', public._hunter_view(pid[1], 1) is null);
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_reveal_position(pid[1], 'chasseurs');
  insert into _report(test, ok) values ('révélation aux chasseurs', public._hunter_view(pid[1], 1) is not null);
  st := public.org_get_overview();
  insert into _report(test, ok, detail) values ('vue org : positions et hors zone',
    exists (select 1 from json_array_elements(st->'players') e where (e->'last_position'->>'out')::boolean),
    (select json_agg(e->'sent') from json_array_elements(st->'pings') e)::text);

  -- Préparation du calcul de fin de manche :
  -- le ping manuel est terminé ; le ping +15 est avancé dans le passé avec un joueur à 2 chasseurs.
  update public.pings set scheduled_at = now() - interval '3 minutes', window_end = now() - interval '2 minutes'
   where kind = 'manuel';
  update public.pings set scheduled_at = now() - interval '10 minutes', window_end = now() - interval '9 minutes'
   where id = (select min(id) from public.pings where kind = 'chasseur');
  update public.assignments set closed_at = now(), close_reason = 'correction' where closed_at is null;
  insert into public.assignments(round, hunter_id, target_id, assigned_at) values
    (1, pid[1], pid[3], now() - interval '30 minutes'),
    (1, pid[2], pid[3], now() - interval '30 minutes'),
    (1, pid[3], pid[1], now() - interval '30 minutes');

  -- Fin de manche
  perform public.org_end_round();
  insert into _report(test, ok) values ('notif : pings restants annulés, fin de manche annoncée',
    not exists (select 1 from public.push_jobs where kind = 'ping' and status = 'attente')
    and exists (select 1 from public.push_jobs where kind = 'fin'));
  insert into _report(test, ok, detail) values ('−3 par ping manqué (1 manuel + 3 sur le ping passé)',
    (select count(*) from public.score_events where reason = 'ping manqué' and points = -3 and player_id = any(pid)) = 4,
    (select string_agg(p.pseudo, ', ') from public.score_events s join public.players p on p.id = s.player_id
      where s.reason = 'ping manqué' and s.player_id = any(pid)));
  insert into _report(test, ok, detail) values ('bonus survivant au joueur à 2 chasseurs',
    (select count(*) from public.score_events where reason = 'bonus survivant') = 1
    and exists (select 1 from public.score_events where reason = 'bonus survivant' and player_id = pid[3]),
    null);
  insert into _report(test, ok) values ('pings futurs non pénalisés',
    not exists (select 1 from public.score_events s join public.pings pg on pg.id::text = s.ref
                 where s.reason = 'ping manqué' and pg.window_end > now()));
  insert into _report(test, ok, detail) values ('fin de manche → regroupement',
    (select status from public.games where id = 1) = 'regroupement'
    and not exists (select 1 from public.assignments where closed_at is null),
    (select status from public.games where id = 1));

  -- Import de joueurs (Nom + Pseudo), doublon ignoré
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  r := public.org_import_players('[{"nom":"Alice Martin","pseudo":"__test_imp1"},{"nom":"Bob","pseudo":"__TEST_1"},{"nom":"","pseudo":""}]'::jsonb);
  insert into _report(test, ok, detail) values ('import : 1 créé, doublon et ligne vide ignorés',
    json_array_length(r->'created') = 1 and json_array_length(r->'skipped') = 2
    and (select full_name from public.players where pseudo = '__test_imp1') = 'Alice Martin', r::text);
  delete from public.players where pseudo = '__test_imp1';

  -- Quêtes : création, déclaration, validation (+points), refus (points retirés)
  v_quest := public.org_save_quest(null, 'Photo devant la cathédrale', 'Selfie', 2, null, null, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u[1], 'role', 'authenticated')::text, true);
  st := public.get_my_state();
  insert into _report(test, ok, detail) values ('quête visible et comptée à faire',
    (st->'quests'->>'todo')::int = 1
    and exists (select 1 from json_array_elements(public.get_quests()) e where (e->>'id')::bigint = v_quest),
    (st->'quests')::text);
  r := public.claim_quest(v_quest, 'fait à 15 h');
  v_total := (select coalesce(sum(points), 0) from public.score_events where player_id = pid[1]);
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_decide_claim((select id from public.quest_claims where quest_id = v_quest), true);
  insert into _report(test, ok, detail) values ('quête validée : +2',
    (select coalesce(sum(points), 0) from public.score_events where player_id = pid[1]) = v_total + 2, null);
  perform public.org_decide_claim((select id from public.quest_claims where quest_id = v_quest), false);
  insert into _report(test, ok) values ('quête refusée ensuite : points retirés',
    (select coalesce(sum(points), 0) from public.score_events where player_id = pid[1]) = v_total);
  perform public.org_delete_quest(v_quest);

  -- Chat
  perform set_config('request.jwt.claims', json_build_object('sub', u[2], 'role', 'authenticated')::text, true);
  r := public.send_chat('Salut tout le monde');
  begin
    perform public.send_chat('trop vite');
    insert into _report(test, ok) values ('chat : anti-flood 3 s', false);
  exception when others then
    insert into _report(test, ok) values ('chat : anti-flood 3 s', true);
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', u[3], 'role', 'authenticated')::text, true);
  st := public.get_chat(0);
  insert into _report(test, ok, detail) values ('chat : message visible avec le pseudo',
    exists (select 1 from json_array_elements(st->'messages') e
             where e->>'author' = '__test_2' and not (e->>'mine')::boolean), left(st::text, 150));
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_set_chat(false);
  perform set_config('request.jwt.claims', json_build_object('sub', u[3], 'role', 'authenticated')::text, true);
  begin
    perform public.send_chat('fermé ?');
    insert into _report(test, ok) values ('chat fermé : envoi refusé aux joueurs', false);
  exception when others then
    insert into _report(test, ok) values ('chat fermé : envoi refusé aux joueurs', true);
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_set_chat(true);

  -- Déconnexion d'un joueur
  perform set_config('request.jwt.claims', json_build_object('sub', u[3], 'role', 'authenticated')::text, true);
  perform public.logout();
  insert into _report(test, ok) values ('déconnexion : téléphone délié',
    public._my_player_id() is null and not exists (select 1 from public.devices where auth_uid = u[3]));

  -- Purge
  perform set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  perform public.org_purge();
  insert into _report(test, ok) values ('purge : plus aucune position', not exists (select 1 from public.positions));

  -- Nettoyage
  perform public.org_reset();
  delete from public.players where id = any(pid);
  delete from public.devices where auth_uid = any(u) or auth_uid = u_org;
  delete from public.event_log where true;
  insert into _report(test, ok) values ('nettoyage', not exists (select 1 from public.players where pseudo like '\_\_test\_%')
    and not exists (select 1 from public.push_jobs));
exception when others then
  get stacked diagnostics v_err = pg_exception_context;
  insert into _report(test, ok, detail) values ('ERREUR : ' || sqlerrm, false, v_err);
  -- Les modifications du bloc sont annulées automatiquement en cas d'erreur.
end $$;

-- Remise des vrais abonnements aux notifications.
insert into public.push_subscriptions overriding system value
select * from _subs where player_id in (select id from public.players)
on conflict do nothing;

select n, test, case when ok then 'OK' else 'ÉCHEC' end as resultat, left(detail, 200) as detail
  from _report order by n;
