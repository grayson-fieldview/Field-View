export const CURRENT_TERMS_VERSION = "2026-04-23";

export const MAX_UPLOAD_BATCH = 100;

export const INDUSTRIES = [
  { value: "general_contractor", label: "General Contractor" },
  { value: "painting", label: "Painting" },
  { value: "roofing", label: "Roofing" },
  { value: "hvac", label: "HVAC" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "landscaping", label: "Landscaping" },
  { value: "remodeling", label: "Remodeling / Renovation" },
  { value: "concrete_masonry", label: "Concrete / Masonry" },
  { value: "flooring", label: "Flooring" },
  { value: "inspection", label: "Inspection" },
  { value: "restoration", label: "Restoration" },
  { value: "property_management", label: "Property Management" },
  { value: "pool", label: "Pool / Spa" },
  { value: "fencing", label: "Fencing" },
  { value: "decks", label: "Decks" },
  { value: "solar", label: "Solar" },
  { value: "siding", label: "Siding" },
  { value: "gutters", label: "Gutters" },
  { value: "drywall", label: "Drywall" },
  { value: "pressure_washing", label: "Pressure Washing" },
  { value: "other", label: "Other" },
] as const;

export const INDUSTRY_VALUES = INDUSTRIES.map((i) => i.value) as readonly string[];

export const COMPANY_SIZES = [
  { value: "1-5", label: "1–5 employees" },
  { value: "6-20", label: "6–20 employees" },
  { value: "21-50", label: "21–50 employees" },
  { value: "51-100", label: "51–100 employees" },
  { value: "100+", label: "100+ employees" },
] as const;

export const COMPANY_SIZE_VALUES = COMPANY_SIZES.map((s) => s.value) as readonly string[];

// Job role — a PERSON attribute collected during onboarding (users.job_role).
// NOT a permission: users.role (admin/standard/restricted) is entirely
// separate, and job role must never be read in an authorization path.
export const JOB_ROLES = [
  { value: "owner_operator", label: "Owner / Operator" },
  { value: "project_manager", label: "Project Manager" },
  { value: "foreman_crew_lead", label: "Foreman / Crew Lead" },
  { value: "estimator", label: "Estimator" },
  { value: "sales", label: "Sales" },
  { value: "office_admin", label: "Office / Admin" },
  { value: "other", label: "Other" },
] as const;

export const JOB_ROLE_VALUES = JOB_ROLES.map((r) => r.value) as readonly string[];

// "How did you hear about us?" — account-level acquisition attribute
// collected during onboarding (users.heard_about_us, admin-set). Never used
// in any authorization path.
export const HEARD_ABOUT_US = [
  { value: "google_search", label: "Google Search" },
  { value: "social_media", label: "Social Media" },
  { value: "paid_social_ad", label: "Facebook / Instagram Ad" },
  { value: "referral", label: "Referral from a friend" },
  { value: "trade_show", label: "Trade Show / Event" },
  { value: "podcast", label: "Podcast" },
  { value: "youtube", label: "YouTube" },
  { value: "other", label: "Other" },
] as const;

export const HEARD_ABOUT_US_VALUES = HEARD_ABOUT_US.map((r) => r.value) as readonly string[];
