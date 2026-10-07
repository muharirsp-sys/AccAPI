/*
 * Tujuan: Kunci localStorage dan skrip pra-render untuk mode (Sistem/Terang/Gelap) dan density Fiori.
 * Caller: app/layout.tsx (skrip di <head>), components/fiori/interactive.tsx (SchemeSwitcher).
 * Dependensi: Tidak ada (sengaja terpisah dari Scope.tsx supaya root layout tidak ikut memuat font Fiori).
 * Main Functions: FIORI_SCHEME_KEY, FIORI_DENSITY_KEY, applyStoredSchemeScript.
 * Side Effects: Skrip menulis html[data-scheme]/html[data-density] dari localStorage sebelum paint.
 */
export const FIORI_SCHEME_KEY = "fiori-scheme";
export const FIORI_DENSITY_KEY = "fiori-density";

// "Sistem" dan "Otomatis" = atribut tidak dipasang; CSS mengikuti prefers-color-scheme / pointer.
export const applyStoredSchemeScript = `(function(){try{var d=document.documentElement,s=localStorage.getItem('${FIORI_SCHEME_KEY}'),n=localStorage.getItem('${FIORI_DENSITY_KEY}');if(s==='light'||s==='dark')d.setAttribute('data-scheme',s);if(n==='compact'||n==='cozy')d.setAttribute('data-density',n);}catch(e){}})();`;
