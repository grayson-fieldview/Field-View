import { renderToStream } from "@react-pdf/renderer";
import { extractS3KeyFromUrl } from "../s3";
import { fetchAndResize } from "./imagePipeline";
import { ReportDocument } from "./layout/Document";
import { FIELDVIEW_LOGO_BYTES } from "./assets/logoBase64";
import type { BodyChunk, BodyPhoto, CoverPageData, CoverToggles } from "./types";

const LOGO_BYTES = FIELDVIEW_LOGO_BYTES;

const PHOTOS_PER_BODY_PAGE = 4;

const DEFAULT_TOGGLES: CoverToggles = {
  showCoverPhoto: true,
  showCompanyLogo: true,
  showCompanyName: true,
  showCreatorName: true,
  showPhotoCount: true,
  showDateCreated: true,
};

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export type PdfData = {
  report: {
    title: string;
    description: string | null;
    coverConfig: Partial<CoverToggles> | null;
    createdAt: Date | string | null;
  };
  account: {
    name: string;
    companyLogoUrl: string | null;
    companyLegalName: string | null;
    companyAddress: string | null;
  };
  creator: { firstName: string | null; lastName: string | null } | null;
  sections: { id: number; title: string; summary: string | null; photos: BodyPhoto[] }[];
  coverPhotoUrl: string | null;
  totalPhotos: number;
};

export async function buildReportPdfStream(data: PdfData): Promise<NodeJS.ReadableStream> {
  const cfg: Partial<CoverToggles> = data.report.coverConfig ?? {};
  const toggles: CoverToggles = { ...DEFAULT_TOGGLES, ...cfg };

  const companyDisplayName =
    data.account.companyLegalName?.trim() || data.account.name;

  const creatorName = data.creator
    ? [data.creator.firstName, data.creator.lastName].filter(Boolean).join(" ").trim() || null
    : null;

  const coverPhotoKey =
    toggles.showCoverPhoto && data.coverPhotoUrl
      ? extractS3KeyFromUrl(data.coverPhotoUrl)
      : null;
  const companyLogoKey =
    toggles.showCompanyLogo && data.account.companyLogoUrl
      ? extractS3KeyFromUrl(data.account.companyLogoUrl)
      : null;

  // Collect all S3 keys (cover + section photos + company logo) for the pipeline.
  const allKeys: string[] = [];
  if (coverPhotoKey) allKeys.push(coverPhotoKey);
  if (companyLogoKey) allKeys.push(companyLogoKey);
  for (const s of data.sections) {
    for (const p of s.photos) {
      if (p.s3Key) allKeys.push(p.s3Key);
    }
  }
  const images = await fetchAndResize(allKeys);

  // Paginate sections: 4 photos per body page; empty section still gets one page.
  const bodyChunks: BodyChunk[] = [];
  for (const s of data.sections) {
    if (s.photos.length === 0) {
      bodyChunks.push({
        sectionTitle: s.title,
        sectionSummary: s.summary,
        isFirstOfSection: true,
        photos: [],
      });
      continue;
    }
    for (let i = 0; i < s.photos.length; i += PHOTOS_PER_BODY_PAGE) {
      bodyChunks.push({
        sectionTitle: s.title,
        sectionSummary: s.summary,
        isFirstOfSection: i === 0,
        photos: s.photos.slice(i, i + PHOTOS_PER_BODY_PAGE),
      });
    }
  }

  const createdAt = data.report.createdAt ? new Date(data.report.createdAt) : new Date();
  const dateText = formatDate(createdAt);

  const cover: CoverPageData = {
    title: data.report.title,
    description: data.report.description,
    toggles,
    companyDisplayName,
    companyAddress: data.account.companyAddress,
    companyLogoKey,
    coverPhotoKey,
    creatorName,
    photoCount: data.totalPhotos,
    dateText,
  };

  const stream = await renderToStream(
    ReportDocument({
      cover,
      bodyChunks,
      reportTitle: data.report.title,
      dateText,
      companyName: companyDisplayName,
      logoBytes: LOGO_BYTES,
      images,
    }) as React.ReactElement,
  );
  return stream as unknown as NodeJS.ReadableStream;
}
