import type { Media, ReportSection, ReportSectionPhoto } from "@shared/schema";

export type EditorMode = "report" | "template";

export type CoverConfig = {
  showCoverPhoto: boolean;
  showCompanyLogo: boolean;
  showCompanyName: boolean;
  showCreatorName: boolean;
  showPhotoCount: boolean;
  showDateCreated: boolean;
  coverPhotoMediaId: number | null;
};

export type SectionPhoto = ReportSectionPhoto & { media: Media };
export type Section = ReportSection & { photos: SectionPhoto[] };

export const DEFAULT_COVER: CoverConfig = {
  showCoverPhoto: true,
  showCompanyLogo: true,
  showCompanyName: true,
  showCreatorName: true,
  showPhotoCount: true,
  showDateCreated: true,
  coverPhotoMediaId: null,
};
