// Textes de l'interface joueur : à modifier ici, sans toucher à la logique.
// Chaque message = une accroche (a, ton des lutins en grève) + une consigne claire (c).
// Variables entre accolades : {points}, {n}, {mm:ss}, {pseudo}, {texte}.
// Les points ne sont jamais écrits en dur : ils viennent des paramètres de la partie.
// Les textes des notifications téléphone sont dans supabase/schema.sql (même ton).
(function () {
  const TEXTES = {
    // Avis de recherche (fiche cible)
    affiche: {
      titre: "WANTED",
      sous_titre: "LUTIN DÉSERTEUR",
      sous_pseudo: "Recherché vif… et en état d'emballer des cadeaux",
      motif: "Motif : ",
      recompense: "RÉCOMPENSE : {points} POINTS ET L'ESTIME DU PÈRE NOËL",
      bas: "Signalé par un collègue bien intentionné"
    },

    // Écrans et alertes
    connexion: { a: "Pointeuse de l'atelier", c: "Entre ton code de lutin.", bouton: "Pointer", champ: "Code de lutin" },
    connexion_erreur: { a: "Inconnu au registre des lutins", c: "Vérifie ton code ou demande à l'organisation." },
    attente: { a: "Assemblée générale des lutins", c: "Le piquet de grève se forme. Le jeu commence bientôt." },
    dispersion: { a: "Dispersez-vous, le contremaître arrive !", c: "10 min pour t'éloigner. Pas de cible, pas de capture." },
    start: { a: "Avis de recherche reçu", c: "Ta cible se cache quelque part en ville." },
    chasseurs_n: { a: "Lutins à tes trousses : {n}", c: "" },
    chasseurs_0: { a: "Personne ne te cherche…", c: "…pour l'instant." },
    bouton_bloque: { a: "Bouton gelé", c: "Disponible dans {mm:ss}" },
    cible_reperee: { a: "Un collègue t'a dénoncé !", c: "Arrête-toi et donne ton code au lutin qui s'approche. ({mm:ss})" },
    saisie_code: { a: "Exige son matricule", c: "4 chiffres, 3 essais, 1 minute.", bouton: "Balancer ce collègue" },
    code_faux: { a: "Mauvais matricule", c: "Encore {n} essai(s)." },
    capture_ok: { a: "Collègue balancé ! +{points}", c: "Le Père Noël note ton zèle. Nouvelle cible en route." },
    capture_subie: { a: "Tu t'es fait balancer ! −{points}", c: "À ton tour de bosser." },
    immunite: { a: "Pause café : {mm:ss}", c: "Personne ne peut te balancer. Ta chasse continue." },
    reperage_rate_chasseur: { a: "Fausse dénonciation !", c: "Bouton gelé 2 min. Aucun point." },
    reperage_rate_cible: { a: "Fausse alerte, tu t'en sors", c: "Immunité de 2 min." },
    cible_prise_par_autre: { a: "Un collègue a été plus rapide", c: "Ta cible a été balancée. Nouvelle cible en route." },

    // Pings, fin de manche, classement
    ping_preavis: { a: "Le Père Noël consulte son registre…", c: "Ping dans 1 minute. Garde ton téléphone en main." },
    ping_chasseurs: { a: "Le Père Noël t'a repéré !", c: "Envoie ta position : seuls tes chasseurs la verront." },
    ping_general: { a: "Le Père Noël se rapproche !", c: "Envoie ta position : tout le monde verra tout le monde." },
    // Ajout : ping demandé par l'organisation à un seul joueur.
    ping_orga: { a: "Le Père Noël t'a repéré !", c: "Envoie ta position à l'organisation." },
    ping_envoye: { a: "Pointage enregistré", c: "Retourne te cacher." },
    ping_manque: { a: "Absent au pointage : −{points}", c: "Le Père Noël n'aime pas les lutins qui se cachent trop bien." },
    hors_perimetre: { a: "Tu as quitté l'atelier !", c: "Reviens dans la zone : pénalité possible." },
    bonus_survivant: { a: "Insaisissable ! +{points}", c: "Plusieurs lutins à tes trousses, et toujours libre." },
    revelation_orga: { a: "Fuite dans la hiérarchie !", c: "La position de {pseudo} vient d'être révélée." },
    message_orga: { a: "Mémo du Père Noël", c: "{texte}" },
    quete_validee: { a: "Quête validée : {points}", c: "« {titre} » : le Père Noël approuve." },
    quete_refusee: { a: "Quête refusée", c: "« {titre} » : retente ta chance, elle est de nouveau validable." },
    quete_refusee_motif: { a: "Quête refusée", c: "« {titre} » : {motif}\nRetente ta chance, elle est de nouveau validable." },
    fin_manche: { a: "Fin de la journée de travail", c: "Retour au point de rendez-vous." },
    regroupement: { a: "Pause syndicale", c: "Classement intermédiaire. Reprise dans 10 min." },
    classement_titre: { a: "Tableau des employés du mois", c: "" },
    classement_premier: { a: "Lutin de l'année", c: "" },
    classement_dernier: { a: "Prime de Noël suspendue", c: "" },
    fin_jeu: { a: "Le Père Noël a fait ses comptes", c: "Merci d'avoir balancé tes collègues." }
  };

  // Onglet Règles. Les chiffres viennent des paramètres de la partie :
  // {dispersion}, {manche}, {defi}, {immunite}, {gel}, {fenetre}, {pings_chasseur}, {ping_general},
  // {capture}, {capture_subie}, {ping_manque}, {survivant}.
  const REGLES = {
    essentiel: {
      a: "Règlement intérieur de l'atelier",
      points: [
        "Tu as une cible : trouve-la et exige son code à 4 chiffres.",
        "D'autres lutins te chassent : reste caché, et donne ton code si on te démasque.",
        "Envoie ta position à chaque ping.",
        "Le lutin qui a le plus de points à la fin gagne l'estime du Père Noël."
      ]
    },
    sections: [
      { id: "securite", titre: "Sécurité et fair-play", a: "Clause non négociable du contrat",
        points: [
          "Respecte le code de la route : on ne court jamais sur la chaussée.",
          "On n'entre ni dans les magasins ni dans les propriétés privées.",
          "Visage toujours découvert.",
          "On ne ment jamais sur son code.",
          "Pars avec un téléphone chargé, et une batterie externe si tu peux.",
          "En cas de souci, préviens l'organisation par le chat."
        ] },
      { id: "deroule", titre: "Déroulé", a: "Planning de la journée de grève",
        points: [
          "Dispersion : {dispersion} pour t'éloigner. Pas de cible, pas de capture.",
          "Manche : {manche} de chasse, chacun reçoit une cible.",
          "Regroupement : retour au point de rendez-vous, classement intermédiaire.",
          "Deuxième manche avec de nouvelles cibles, puis classement final."
        ] },
      { id: "capturer", titre: "Capturer ta cible", a: "Procédure de dénonciation",
        points: [
          "Tu penses avoir trouvé ta cible ? Appuie sur « Wanted ! ». Elle est prévenue, mais ne sait pas qui tu es.",
          "Approche-toi et demande-lui son code : tu as {defi} et 3 essais pour le saisir.",
          "Code bon : +{capture} pour toi, et tu reçois une nouvelle cible.",
          "Temps écoulé ou 3 codes faux : ta cible est protégée {immunite} et ton bouton est gelé {gel}."
        ] },
      { id: "repere", titre: "Quand on te repère", a: "Tu as été dénoncé",
        points: [
          "Ton téléphone sonne et affiche ton code : arrête-toi.",
          "Donne ton code au lutin qui s'approche, honnêtement.",
          "Capturé : {capture_subie}. Tu reçois un nouveau code et {immunite} de protection.",
          "Une fois protégé, personne ne peut te repérer jusqu'à la fin de la protection."
        ] },
      { id: "pings", titre: "Pings de position", a: "Pointage obligatoire",
        points: [
          "Pings chasseur à {pings_chasseur} après le début : ton chasseur voit où tu es.",
          "Ping général à {ping_general} : tout le monde voit tout le monde.",
          "Tu as {fenetre} pour appuyer sur « Envoyer ma position ». Une notification te prévient 1 min avant.",
          "Ping manqué : {ping_manque}."
        ] },
      { id: "points", titre: "Barème", a: "Grille des primes",
        bareme: [
          ["Capture", "+{capture}"],
          ["Être capturé", "{capture_subie}"],
          ["Ping manqué", "{ping_manque}"],
          ["Bonus survivant (au moins 2 chasseurs sur toi à un ping, sans te faire prendre)", "+{survivant}"],
          ["Quête validée", "selon la quête"],
          ["Sortie du périmètre (montant décidé par l'organisation)", "−1 minimum"]
        ] },
      { id: "zone", titre: "Zone de jeu", a: "Les murs de l'atelier",
        points: [
          "Reste dans le périmètre tracé sur la carte de l'écran Jeu.",
          "Une position envoyée hors zone est signalée à l'organisation : pénalité d'au moins −1 point."
        ] },
      { id: "quetes", titre: "Quêtes", a: "Heures supplémentaires",
        points: [
          "Des quêtes faciles, modérées ou difficiles rapportent des points en plus.",
          "Réalise-la, appuie sur « J'ai réussi » et ajoute une photo de preuve.",
          "L'organisation valide ou refuse. Une quête refusée peut être redéclarée."
        ] },
      { id: "aide", titre: "Un problème ?", a: "Bureau des réclamations",
        points: [
          "Écris à l'organisation dans l'onglet Chat (choisis « Organisation »).",
          "Panne de téléphone ou de réseau : un ping manqué peut être corrigé par l'organisation."
        ] }
    ]
  };

  // Motifs des avis de recherche. La base tire un numéro de 1 à 40 (jamais deux fois le même
  // pour un chasseur) : si tu changes le nombre de motifs, change aussi _assign_motif dans schema.sql.
  const MOTIFS = [
    "Grève non autorisée",
    "Abandon de poste à l'atelier",
    "Pause café de trois semaines",
    "Piquet de grève devant la cheminée",
    "Distribution de tracts dans les chaussettes",
    "A exigé les 35 heures… par an",
    "Revendique un 13e mois en sucres d'orge",
    "Préavis de grève rédigé sur du papier cadeau",
    "Sabotage de rubans",
    "Refus d'emballer les chaussettes",
    "Emballage bâclé avec du scotch marron",
    "A collé les étiquettes au hasard",
    "A remplacé les jouets par des cailloux",
    "Piles « non fournies » de façon systématique",
    "A monté un meuble sans la notice",
    "Perte de 400 pièces de puzzle",
    "Vol de biscuits destinés au Père Noël",
    "A bu le lait laissé pour le Père Noël",
    "Trafic de chocolats de l'Avent",
    "A ouvert toutes les cases du calendrier le 1er décembre",
    "Consommation excessive de pain d'épices",
    "A mangé les carottes des rennes",
    "Propos désobligeants sur l'odeur des rennes",
    "A peint le nez de Rudolph en vert",
    "Excès de vitesse en traîneau",
    "Stationnement du traîneau sur un passage piéton",
    "A appris aux rennes à faire grève",
    "Plein du traîneau à l'eau de vaisselle",
    "Sieste prolongée dans la hotte",
    "A confondu la cheminée et la boîte aux lettres",
    "Se cache dans les guirlandes depuis lundi",
    "A répondu « c'est pas mon rayon » au Père Noël",
    "Arrivé en retard à son propre pot de départ",
    "Karaoké clandestin dans l'entrepôt",
    "A égaré la liste des enfants sages",
    "A rangé tout le monde dans la liste des pas sages",
    "A répondu à toutes les lettres par « non »",
    "Faux arrêt maladie pour « allergie aux paillettes »",
    "A mis le Père Noël en copie cachée",
    "Dénonciation abusive de collègues"
  ];

  // Remplace les {variables}.
  function fill(str, vars) {
    return String(str || "").replace(/\{([a-z_:]+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));
  }
  // T("capture_ok", { points: 3 }) → { a, c } avec les variables remplacées.
  function T(key, vars) {
    const t = TEXTES[key] || { a: key, c: "" };
    const out = {};
    Object.keys(t).forEach(k => { out[k] = fill(t[k], vars); });
    return out;
  }
  // Texte d'une alerte sur deux lignes (accroche puis consigne).
  function line(key, vars) {
    const t = T(key, vars);
    return t.c ? `${t.a}\n${t.c}` : t.a;
  }
  // Motif n° 1 à 40 (null si inconnu).
  function motif(n) {
    return n >= 1 && n <= MOTIFS.length ? MOTIFS[n - 1] : null;
  }

  window.TXT = { TEXTES, MOTIFS, REGLES, T, line, fill, motif };
})();
