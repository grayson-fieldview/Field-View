import { Document } from "@react-pdf/renderer";
import { CoverPage } from "./CoverPage";
import { BodyPage } from "./BodyPage";
import type { CoverPageData, BodyChunk } from "../types";

export function ReportDocument({
  cover,
  bodyChunks,
  reportTitle,
  dateText,
  companyName,
  logoBytes,
  images,
}: {
  cover: CoverPageData;
  bodyChunks: BodyChunk[];
  reportTitle: string;
  dateText: string;
  companyName: string;
  logoBytes: Buffer;
  images: Map<string, Buffer>;
}) {
  return (
    <Document>
      <CoverPage data={cover} images={images} />
      {bodyChunks.map((chunk, i) => (
        <BodyPage
          key={i}
          chunk={chunk}
          reportTitle={reportTitle}
          dateText={dateText}
          companyName={companyName}
          logoBytes={logoBytes}
          images={images}
        />
      ))}
    </Document>
  );
}
