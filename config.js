// Nissan Scrap PWA - settings
window.APP_CONFIG = {
  customer:     "NISSAN",
  // Shared PIN sign-in (same function the TRAFO app uses)
  loginUrl:     "https://tjivcqxnkftujceumdtx.supabase.co/functions/v1/customer-inventory",
  // Nissan scrap analytics
  dataUrl:      "https://tjivcqxnkftujceumdtx.supabase.co/functions/v1/nissan-scrap",
  matureDays:   21,          // cohort weeks/ranges younger than this are "developing"
  defaultRange: "30",
};
