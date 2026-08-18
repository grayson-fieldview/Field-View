import { StyleSheet } from "@react-pdf/renderer";

export const PAGE_MARGIN = 54;

// Accent used ONLY for the cover rule, section-heading rule, and footer rule.
// TODO: plug in a per-account brand color here once one exists on the
// accounts table (accounts has companyLogoUrl/LegalName/Address but no color;
// showcase_settings.brandColor is a different, showcase-only feature).
// Never Field View orange — this document represents the contractor.
export const ACCENT = "#1a1a1a";

const INK = "#1E1E1E";
const BODY = "#3F3F3F";
const MUTED = "#737373";
const RULE = "#E5E5E5";

// Typography scale:
//   Report title 32 bold / Section heading 18 bold / Photo caption 10 semibold
//   Body 9 regular (lineHeight 1.4) / Meta 8 muted
export const styles = StyleSheet.create({
  page: {
    paddingTop: PAGE_MARGIN,
    paddingBottom: PAGE_MARGIN,
    paddingLeft: PAGE_MARGIN,
    paddingRight: PAGE_MARGIN,
    fontFamily: "Helvetica",
    fontSize: 9,
    color: INK,
  },

  // ---- Cover page (left-aligned letterhead layout) ----
  coverPage: {
    paddingTop: PAGE_MARGIN,
    paddingBottom: PAGE_MARGIN,
    paddingLeft: PAGE_MARGIN,
    paddingRight: PAGE_MARGIN,
    fontFamily: "Helvetica",
    color: INK,
  },
  letterheadLogo: { width: 56, height: 56, marginBottom: 10, objectFit: "contain", alignSelf: "flex-start" },
  companyName: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: INK,
    marginBottom: 2,
  },
  companyAddress: { fontSize: 8, color: MUTED, lineHeight: 1.4 },
  coverRule: {
    borderBottomWidth: 1.5,
    borderBottomColor: ACCENT,
    marginTop: 20,
  },
  coverTitle: {
    fontSize: 32,
    fontFamily: "Helvetica-Bold",
    color: INK,
    marginTop: 48,
    marginBottom: 10,
  },
  coverDescription: {
    fontSize: 9,
    color: BODY,
    lineHeight: 1.4,
    marginBottom: 24,
  },
  coverPhotoBox: {
    width: "100%",
    height: 252,
    marginTop: 8,
    position: "relative",
  },
  coverPhoto: { width: "100%", height: "100%", objectFit: "cover" },
  coverMeta: { marginTop: "auto", paddingTop: 16 },
  coverMetaLine: { fontSize: 8, color: MUTED, marginBottom: 3 },

  // ---- Body page header / footer ----
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: RULE,
    marginBottom: 16,
  },
  headerTitle: { fontSize: 8, fontFamily: "Helvetica-Bold", color: MUTED },
  headerDate: { fontSize: 8, color: MUTED },
  footer: {
    position: "absolute",
    bottom: 18,
    left: PAGE_MARGIN,
    right: PAGE_MARGIN,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: ACCENT,
    paddingTop: 6,
  },
  footerText: { fontSize: 8, color: MUTED, flex: 1 },
  footerCenter: { fontSize: 8, color: MUTED, flex: 1, textAlign: "center" },
  footerRight: { flex: 1, alignItems: "flex-end" },
  footerLogo: { height: 14, width: 14, objectFit: "contain" },

  // ---- Sections ----
  sectionHeaderBlock: {
    borderBottomWidth: 1.5,
    borderBottomColor: ACCENT,
    paddingBottom: 4,
    marginBottom: 8,
  },
  sectionHeader: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    color: INK,
  },
  sectionSummary: { fontSize: 9, color: BODY, lineHeight: 1.4, marginBottom: 14 },

  // ---- Photo grid: fixed image height + cover so caption blocks in a row
  // share a baseline; descriptions clamp (maxLines) so rows stay aligned ----
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    width: "48%",
    marginRight: "2%",
    marginBottom: 16,
  },
  cellPhotoBox: {
    width: "100%",
    height: 168,
    marginBottom: 6,
    position: "relative",
  },
  cellPhoto: { width: "100%", height: "100%", objectFit: "cover" },
  cellPhotoMissing: {
    width: "100%",
    height: "100%",
    backgroundColor: "#F0EDEA",
  },
  cellCaption: { fontSize: 10, fontFamily: "Helvetica-Bold", color: INK, marginBottom: 2 },
  cellDescription: { fontSize: 9, color: BODY, lineHeight: 1.4 },
  cellTimestamp: { fontSize: 8, color: MUTED, marginTop: 2 },

  // ---- Timestamp/address overlay (photo overlay setting) ----
  // Procore treatment: top-right, right-aligned, no background fill. The
  // "shadow" box is an identical dark text layer offset ~0.6pt, rendered
  // beneath the white layer — @react-pdf has no text-shadow.
  overlayCornerBox: { position: "absolute", top: 4, left: 0, right: 6 },
  overlayCornerShadowBox: { position: "absolute", top: 4.6, left: 0.6, right: 5.4 },
  overlayCornerText: {
    fontSize: 6.5,
    color: "#FFFFFF",
    lineHeight: 1.4,
    textAlign: "right",
  },
  overlayCornerShadow: {
    fontSize: 6.5,
    color: "#000000",
    opacity: 0.75,
    lineHeight: 1.4,
    textAlign: "right",
  },
  overlayCornerTextLarge: {
    fontSize: 8,
    color: "#FFFFFF",
    lineHeight: 1.4,
    textAlign: "right",
  },
  overlayCornerShadowLarge: {
    fontSize: 8,
    color: "#000000",
    opacity: 0.75,
    lineHeight: 1.4,
    textAlign: "right",
  },
});
