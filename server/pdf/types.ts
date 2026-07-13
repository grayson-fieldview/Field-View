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
