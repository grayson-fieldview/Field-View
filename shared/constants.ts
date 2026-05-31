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
