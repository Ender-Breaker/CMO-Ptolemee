/* ==========================================================================
   GOC — Division PTOLÉMÉE · Configuration Firebase
   Console Firebase → Paramètres du projet → Vos applications → Application Web.
   Ces valeurs sont publiques par nature (elles identifient le projet, elles ne
   donnent aucun droit) : la sécurité est assurée par les Cloud Functions.

   apiKey vide  → mode local (prototype localStorage, comptes à mot de passe).
   apiKey remplie → mode Firebase (connexion Google, état officiel en base Firestore).
   ========================================================================== */

window.GOC_FIREBASE = {
    apiKey: 'AIzaSyBs3EV5X_5D-WlFILaZKiaJRCGi7S0F-9o',
    authDomain: 'ptomelee-f8568.firebaseapp.com',
    projectId: 'ptomelee-f8568',
    appId: '1:911924897482:web:85329ca9af25df4d71b633',
    region: 'europe-west1',  // doit correspondre à la région des Cloud Functions
    sdk: '10.14.1'           // version du SDK Firebase (compat) chargée depuis gstatic
};
