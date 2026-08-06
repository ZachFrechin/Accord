/**
 * Patch notes for the in-app « Nouveautés » page — one entry per released tag,
 * newest first, written for users. scripts/ci-set-version.mjs refuses to stamp
 * a tagged version that has no entry here, which is what keeps the version
 * numbers and the notes coherent release after release.
 */

export interface ChangelogEntry {
  version: string;
  /** ISO date (YYYY-MM-DD) of the release tag. */
  date: string;
  title: string;
  notes: string[];
  /** Infrastructure-only release (no user-visible change) — rendered compact. */
  technical?: boolean;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.16.3",
    date: "2026-08-06",
    title: "Vos conversations chargent, quoi qu'il arrive",
    notes: [
      "La liste des conversations ne dépend plus du chiffrement pour s'afficher. Elle était chargée APRÈS la mise en route du moteur de chiffrement : quand celui-ci restait bloqué, l'application n'appelait plus le serveur du tout — conversations vides, envoi impossible, appels indisponibles, et pas le moindre message d'erreur.",
      "Le moteur de chiffrement a désormais un délai maximum. Bloqué, il renonce au lieu de figer l'application, et réessaie à la reconnexion suivante.",
    ],
  },
  {
    version: "0.16.2",
    date: "2026-08-06",
    title: "Conversations qui ne chargent plus : le correctif",
    notes: [
      "Un appareil pouvait rester définitivement hors de ses conversations chiffrées : messages qui ne chargent pas, envoi qui échoue, « appel chiffré indisponible ». Les invitations au groupe n'étaient lues qu'au lancement, et un seul échec au démarrage suffisait à laisser l'appareil dehors pour de bon.",
      "Elles sont maintenant reprises à chaque reconnexion : un appareil resté dehors se rattrape tout seul, sans réinstallation.",
    ],
  },
  {
    version: "0.16.1",
    date: "2026-08-06",
    title: "Déconnexions, présence et groupes — les correctifs",
    notes: [
      "Une panne passagère du serveur ne vous déconnecte plus. Elle effaçait votre session pour de bon : il fallait se reconnecter à la main, et chaque redémarrage du serveur déconnectait tout le monde.",
      "Une personne ajoutée à un groupe existant peut enfin y écrire et y appeler. Elle rejoignait la conversation sans recevoir les clés de chiffrement, donc sans pouvoir rien lire ni envoyer.",
      "La présence est corrigée des deux côtés : les changements en ligne / hors ligne arrivent maintenant en direct, et l'état de chacun est connu dès l'ouverture au lieu d'attendre le premier changement.",
      "Les pastilles de présence sont plus grandes et visibles partout — y compris dans la liste des conversations, et en gris quand la personne est hors ligne.",
      "Si le coffre sécurisé de l'appareil devient illisible, Accord le dit désormais au lieu de rester silencieusement inerte.",
      "Le logo perd son fond gris et son halo.",
      "Sur Android : les appels vocaux et vidéo arrivent, chiffrés de bout en bout comme sur ordinateur.",
    ],
  },
  {
    version: "0.16.0",
    date: "2026-08-03",
    title: "Fermer sans quitter, et un panel d'administration complet",
    notes: [
      "La croix range Accord dans la barre de menus au lieu de le quitter : un appel en cours n'est plus coupé par une fenêtre qu'on referme. Un clic sur l'icône le ramène, « Quitter » l'arrête pour de bon.",
      "Correction d'un bug qui, toutes les dix minutes, vous ramenait au menu en quittant la conversation ouverte — y compris pendant un appel.",
      "Un son signale les arrivées et les départs en vocal, et les appels manqués laissent une trace dans la conversation.",
      "Les réglages d'un groupe passent dans une roue crantée en haut de la conversation, où ils sont enfin trouvables.",
      "La liste des conversations affiche l'état de votre interlocuteur, et le nombre de personnes présentes dans un groupe.",
      "Panel d'administration refondu en onglets : suspensions à durée choisie avec motif, réinitialisation de mot de passe, gestion des niveaux, des groupes et des rôles, avec recherche et tri.",
      "Accord a son logo, sur l'application comme dans la barre des tâches.",
      "Deux failles corrigées dans des bibliothèques tierces, et les avatars s'affichent de nouveau en tête de conversation.",
    ],
  },
  {
    version: "0.15.0",
    date: "2026-08-02",
    title: "Accord passe en open source",
    notes: [
      "Le code d'Accord est désormais public, sous licence AGPL-3.0 : n'importe qui peut l'auditer, l'héberger, ou vérifier que le serveur ne peut effectivement pas lire vos messages.",
      "Les mises à jour automatiques changent d'adresse. Cette version est à installer à la main ; les suivantes reprendront leur cours normal.",
      "Une application Android arrive : même cœur de chiffrement que le bureau, avec ses notifications et sa reprise après veille.",
      "Deux failles de sécurité corrigées dans des bibliothèques tierces — un déni de service sur certificat malformé, et un contournement de protection dans le routeur.",
    ],
  },
  {
    version: "0.14.1",
    date: "2026-07-31",
    title: "Finitions du profil",
    notes: [
      "Les cartes de Réglages → Profil suivent enfin le curseur « Conteneurs » comme le reste de l'app.",
      "La photo de profil éditable perd son cadre disgracieux.",
      "Le menu du compte (avatar en bas à gauche) affiche votre photo au lieu de vos initiales.",
    ],
  },
  {
    version: "0.14.0",
    date: "2026-07-30",
    title: "Personnalisation totale",
    notes: [
      "Nouveau curseur « Conteneurs » : les cartes internes (début de conversation, Réglages, Amis, Admin, Classement) ont leur propre transparence, indépendante du chat.",
      "Réglez l'épaisseur des séparateurs (0 à 4 px) : rail, listes, header, barre des membres.",
      "Typographie libre : couleur de chaque rôle de texte (principal, secondaire, atténué) en clair comme en sombre, graisse du texte et des titres, et contour du texte réglable (épaisseur + couleur).",
      "« Ouvrir dans une nouvelle fenêtre » ouvre bien la conversation (fini l'écran vide).",
      "Tous ces réglages entrent dans vos personnalisations sauvegardées.",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-07-30",
    title: "Personnalisations sauvegardées",
    notes: [
      "Sauvegardez plusieurs apparences complètes — réglages ET fond d'écran inclus — et revenez à n'importe laquelle en un clic depuis le panneau Personnaliser.",
      "À 100 % de transparence, les pages Réglages, Amis et Admin gardent un léger voile pour rester lisibles ; le chat, lui, reste totalement transparent.",
      "Re-choisir un fond du même type (image sur image) s'affiche désormais immédiatement.",
    ],
  },
  {
    version: "0.12.3",
    date: "2026-07-29",
    title: "Fonds image et vidéo éclatants",
    notes: [
      "Le voile posé sur les fonds image et vidéo disparaît : plus de blanchiment en mode clair ni d'assombrissement en mode sombre — vos couleurs ressortent telles quelles.",
    ],
  },
  {
    version: "0.12.2",
    date: "2026-07-29",
    title: "Transparence totale et finitions",
    notes: [
      "100 % de transparence est enfin vraiment 100 % : plus aucun voile sur votre fond d'écran, en clair comme en sombre (remontez votre curseur, l'échelle a été corrigée).",
      "La photo de profil des Réglages n'est plus enfermée dans un anneau ovale — le cadre suit la forme choisie pour vos avatars.",
      "Les icônes des sections Audio & vidéo passent en carrés arrondis, comme sur la page Amis.",
    ],
  },
  {
    version: "0.12.1",
    date: "2026-07-29",
    title: "Correctifs des appels",
    notes: [
      "La fenêtre séparée d'un stream affiche bien le flux chiffré (elle démarrait parfois avant la connexion au compte).",
      "« Agrandir » prend désormais tout l'espace : panneau membres masqué, messages repliés, la vidéo remplit le panneau.",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-07-29",
    title: "Appels repensés",
    notes: [
      "Le bandeau d'appel est refait façon Discord : une bande participants qui défile (plus rien de tronqué), et en dessous les caméras et partages d'écran en tuiles.",
      "Agrandissez n'importe quelle tuile (double-clic) puis passez en plein écran, ou ouvrez-la dans sa propre fenêtre — une fenêtre par stream si besoin.",
      "Le partage d'écran diffuse le son (quand le système le permet), avec un volume réglable par stream.",
      "Réglez le volume de la voix de chaque personne (clic sur son avatar) — mémorisé pour la prochaine fois.",
      "Changez de micro, caméra ou sortie audio en plein appel, depuis le nouveau menu du bandeau ou les Réglages — plus besoin de raccrocher.",
      "Liste de conversations : les séparateurs respirent et ne se confondent plus avec la sélection.",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-07-28",
    title: "Niveaux, rangs et jeux vidéo",
    notes: [
      "Gagnez de l'XP en discutant et en appelant : 15 rangs à gravir, de Novice au Tout et le Rien, visibles sur votre profil avec votre progression.",
      "Nouvelle page Classement : le top de l'instance, cette semaine ou depuis toujours, avec podium.",
      "Liez vos comptes de jeu (Réglages → Jeux) : votre rang League of Legends (emblème officiel) et votre niveau FACEIT CS2 s'affichent sur votre profil.",
      "Les rangs se mettent à jour automatiquement, avec un bouton Actualiser ; vous pouvez délier à tout moment.",
      "Un toast célèbre chaque passage de niveau — et l'anti-spam veille : un gain par minute maximum, les appels ne comptent qu'à plusieurs.",
      "Valorant et Rocket League arrivent bientôt.",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-07-28",
    title: "Profils, modération et réglages audio",
    notes: [
      "Le profil s'enrichit : rôles de l'instance en badges colorés, couronne pour les admins, et activité en direct — on voit si la personne est en appel.",
      "La page Audio & vidéo est refaite : test du micro avec vu-mètre, sonneries à écouter d'un clic, fichiers importés avec nom et durée, lecture/arrêt fiables.",
      "Nouvelles permissions fines pour les rôles : suppression des messages, modification des pseudos, journal d'audit.",
      "Les modérateurs peuvent supprimer n'importe quel message — même chiffré de bout en bout, sans que le serveur ne lise jamais rien.",
      "Panel admin : renommez un membre (pseudo et nom d'affichage) et suivez toutes les actions d'administration dans un journal paginé.",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-07-28",
    title: "Correctifs de la 0.9.0",
    notes: [
      "La barre d'actions des messages redevient discrète — plus de carte flottante, et le menu « ⋯ » s'ouvre au bon endroit.",
      "Importer votre propre fichier audio comme sonnerie fonctionne : bouton trombone à côté de chaque ami dans Audio & vidéo.",
      "Le compteur de non-lus et la ligne « Nouveaux messages » disparaissent vraiment une fois la conversation lue.",
      "Certaines 0.9.0 distribuées ce matin n'avaient pas ces correctifs : cette mise à jour les apporte à tout le monde.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-07-28",
    title: "Sonneries personnalisées et polish",
    notes: [
      "Choisissez une sonnerie différente pour chaque ami — y compris votre propre fichier audio (.mp3, .ogg…) — depuis Réglages → Audio & vidéo, avec recherche par pseudo.",
      "Un badge vérifié s'affiche à côté du nom quand vous avez vérifié les clés de quelqu'un, façon réseaux sociaux.",
      "La conversation active se repère à une barre accent discrète, fini l'encadré ; l'avatar reste aligné en haut du message même pour les images.",
      "Les images ne changent plus de taille quand la barre d'actions apparaît, et le menu « ⋯ » s'ouvre au bon endroit.",
      "Réglages : la barre de défilement retrouve le bord droit de la fenêtre ; panneau membres allégé.",
      "Le compteur de non-lus et la ligne « Nouveaux messages » disparaissent pour de bon une fois la conversation lue, même après un redémarrage.",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-07-28",
    title: "Finitions d'interface",
    notes: [
      "macOS : les barres d'actions des messages ne laissent plus de copies fantômes en survolant le fil.",
      "Le panneau de droite s'adapte : membres dans une conversation, tous vos amis sur la page Amis, masqué dans Admin et Paramètres.",
      "Panneau membres allégé ; la vérification des clés vit désormais dans l'en-tête du chat (bouclier).",
      "Réglages : onglets sur une seule ligne, onglet Statut retiré, plus de bandeau sombre sous « Enregistrer les modifications ».",
      "Liste de conversations : séparateurs fins visibles sur tous les thèmes ; survol des emoji et du « + » parfaitement aligné ; images sans cadre superflu.",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-07-28",
    title: "Sonneries, rôles et permissions",
    notes: [
      "Les appels sonnent enfin : quatre sonneries au choix, volume réglable, et une sonnerie différente par contact si vous le souhaitez.",
      "Nouveaux réglages Audio & vidéo : choisissez le micro, la caméra et la sortie audio utilisés pendant les appels.",
      "Administration : créez des rôles personnalisés avec des permissions précises, assignez-les en un clic — les membres sont désormais groupés par rôle.",
      "Le panneau d'administration s'allège (les grosses boîtes de statistiques disparaissent) et l'accès suit vos permissions.",
      "Finitions : survol des emoji et des boutons parfaitement aligné, images sans cadre superflu dans le fil.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-07-27",
    title: "Chiffrement MLS partout",
    notes: [
      "Toutes les conversations passent au chiffrement de bout en bout MLS (RFC 9420) : les nouvelles naissent ainsi, les anciennes se mettent à niveau automatiquement à l'ouverture.",
      "La mise à niveau est à sens unique — le retour au chiffrement historique n'existe plus, et le serveur le refuse.",
      "Votre historique d'avant la migration reste lisible, rien n'est perdu.",
      "Le tout vérifié par des tests de bout en bout à deux appareils : création arbitrée, réparation, révocation.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-07-27",
    title: "Fils, partage d'écran et réactions chiffrées",
    notes: [
      "Fils de discussion : répondez « en fil » dans un panneau latéral, avec un compteur de réponses sur le message d'origine.",
      "Partage d'écran pendant les appels — chiffré de bout en bout, comme le reste.",
      "Les réactions fonctionnent sur tous les messages, et elles sont désormais chiffrées elles aussi.",
      "Le sélecteur d'emoji est là, les images s'affichent directement dans le fil (collez une capture d'écran !), et les liens montrent un aperçu généré par l'expéditeur — le serveur ne visite jamais vos liens.",
      "Transférer un message, galerie des médias de la conversation, brouillons conservés par conversation.",
      "Notifications réglables par conversation (tout / mentions / rien) ; groupes avec avatar et description.",
      "Sauvegarde chiffrée de l'historique (Réglages → Sauvegarde) : changez de machine sans perdre vos conversations.",
      "Une conversation peut s'ouvrir dans sa propre fenêtre ; navigation Alt+↑/↓ ; l'indicateur « en train d'écrire » est enfin fiable.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-07-27",
    title: "Édition, vocaux et épingles",
    notes: [
      "Modifiez vos messages après envoi — chiffré de bout en bout, comme tout le reste.",
      "Messages vocaux : enregistrez depuis la zone de saisie, écoutez directement dans le fil.",
      "Épinglez les messages importants et retrouvez-les dans le panneau de détails.",
      "La recherche (⌘K) couvre désormais tout votre historique local et ignore les accents.",
      "Cliquer une notification ouvre la conversation ; le nombre de non-lus s'affiche sur l'icône de l'app ; « Ne pas déranger » coupe vraiment les notifications.",
      "Statut personnalisé à durée limitée, liens d'invitation accord://, et un démarrage nettement plus vif.",
    ],
  },
  {
    version: "0.4.6",
    date: "2026-07-27",
    title: "Notifications système",
    notes: [
      "Les notifications sont désormais émises par le système lui-même : Accord apparaît dans les réglages de notifications de macOS et de Windows, avec son nom et son icône.",
      "À l'activation de l'option, une notification de confirmation est envoyée — c'est elle qui déclenche la demande d'autorisation du système.",
    ],
  },
  {
    version: "0.4.5",
    date: "2026-07-27",
    title: "Correctifs d'interface sur Windows",
    notes: [
      "Les animations de l'accueil et de l'indicateur de frappe s'animent à nouveau (elles restaient figées sur certains PC).",
      "L'indicateur « est en train d'écrire » disparaît dès l'envoi du message.",
      "Contour de focus des champs de saisie affiné, sans double bordure.",
    ],
  },
  {
    version: "0.4.4",
    date: "2026-07-26",
    title: "Mises à jour automatiques partout",
    notes: [
      "Première version livrée simultanément sur macOS et Windows, avec mises à jour automatiques signées des deux côtés.",
    ],
  },
  {
    version: "0.4.3",
    date: "2026-07-26",
    title: "Version technique",
    notes: ["Fiabilisation de la signature des mises à jour Windows."],
    technical: true,
  },
  {
    version: "0.4.2",
    date: "2026-07-26",
    title: "Version technique",
    notes: ["Validation de la clé de signature dans la chaîne de publication."],
    technical: true,
  },
  {
    version: "0.4.1",
    date: "2026-07-26",
    title: "Version technique",
    notes: ["Première tentative de publication Windows signée."],
    technical: true,
  },
  {
    version: "0.4.0",
    date: "2026-07-26",
    title: "L'app se met à jour toute seule",
    notes: [
      "Bannière de mise à jour intégrée : « Installer et redémarrer », téléchargement signé et vérifié.",
      "Chiffrement plus robuste : les appareils détectent et réparent seuls les divergences de groupe — plus de conversations bloquées après un conflit multi-appareils.",
      "Création de conversation arbitrée par le serveur : fini les doublons quand deux appareils créent le même groupe en même temps.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-20",
    title: "Nouvelle navigation",
    notes: [
      "Profil flottant, page Amis dédiée et tableau de bord d'administration.",
      "Windows : l'état de chiffrement est conservé de manière fiable d'une session à l'autre.",
      "Windows : correction de la connexion aux serveurs depuis l'app installée.",
    ],
  },
  {
    version: "0.2.2",
    date: "2026-07-20",
    title: "Accord arrive sur Windows",
    notes: ["Installeurs Windows (.msi et .exe) publiés aux côtés du .dmg macOS."],
  },
  {
    version: "0.2.1",
    date: "2026-07-20",
    title: "Version technique",
    notes: ["Activation de la chaîne de build Windows."],
    technical: true,
  },
  {
    version: "0.2.0",
    date: "2026-07-20",
    title: "Administration",
    notes: [
      "Panneau d'administration de l'instance : vue d'ensemble, rôles et gestion des comptes.",
      "Barre de titre macOS native, fenêtre mieux intégrée au système.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-07-19",
    title: "Première version",
    notes: [
      "Messagerie chiffrée de bout en bout (MLS) : conversations privées et de groupe, réactions, réponses, mentions.",
      "Amis, présence en direct et sessions multi-appareils.",
      "Appels audio et vidéo chiffrés.",
      "Multi-serveurs : plusieurs comptes et instances dans une seule application.",
      "Vérification des clés de sécurité et double authentification (TOTP).",
    ],
  },
];

/** Latest version that has patch notes (the top entry). */
export const LATEST_NOTES_VERSION = CHANGELOG[0]?.version ?? "";

const SEEN_KEY = "accord.changelog.lastSeen";

/** True until the user has opened « Nouveautés » for the current top entry. */
export function hasUnseenChangelog(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== LATEST_NOTES_VERSION;
  } catch {
    return false;
  }
}

export function markChangelogSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, LATEST_NOTES_VERSION);
  } catch {
    /* storage unavailable — the unseen dot just stays */
  }
}
