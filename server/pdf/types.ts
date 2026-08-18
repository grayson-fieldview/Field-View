export type CoverToggles = {
  showCoverPhoto: boolean;
  showCompanyLogo: boolean;
  showCompanyName: boolean;
  showCreatorName: boolean;
  showPhotoCount: boolean;
  showDateCreated: boolean;
};

export type CoverPageData = {
  title: string;
  description: string | null;
  toggles: CoverToggles;
  companyDisplayName: string;
  companyAddress: string | null;
  companyLogoKey: string | null;
  coverPhotoKey: string | null;
  creatorName: string | null;
  photoCount: number;
  dateText: string;
  /** Timestamp/address strip over the cover photo (null = overlay off). */
  overlay: PhotoOverlayInfo | null;
};

/** Content of the burned-in strip drawn over a photo's bottom edge. */
export type PhotoOverlayInfo = {
  timestamp: string | null;
  address: string | null;
};

export type BodyPhoto = {
  id: number;
  s3Key: string | null;
  caption: string | null;
  description: string | null;
  createdAt: Date | string | null;
  latitude: number | null;
  longitude: number | null;
  timestamp?: string | null;
};

export type BodyChunk = {
  sectionTitle: string;
  sectionSummary: string | null;
  isFirstOfSection: boolean;
  photos: BodyPhoto[];
};

/** Document-level overlay config: enabled flag + project address line. */
export type OverlayConfig = {
  enabled: boolean;
  projectAddress: string | null;
};
