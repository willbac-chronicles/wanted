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
    fin_manche: { a: "Fin de la journée de travail", c: "Retour au point de rendez-vous." },
    regroupement: { a: "Pause syndicale", c: "Classement intermédiaire. Reprise dans 10 min." },
    classement_titre: { a: "Tableau des employés du mois", c: "" },
    classement_premier: { a: "Lutin de l'année", c: "" },
    classement_dernier: { a: "Prime de Noël suspendue", c: "" },
    fin_jeu: { a: "Le Père Noël a fait ses comptes", c: "Merci d'avoir balancé tes collègues." }
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

  window.TXT = { TEXTES, MOTIFS, T, line, fill, motif };
})();
