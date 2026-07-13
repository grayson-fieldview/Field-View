import { Page, Text, View } from "@react-pdf/renderer";
import { styles } from "./styles";
import { Header } from "./Header";
import { Footer } from "./Footer";
import { PhotoCell } from "./PhotoCell";
import type { BodyChunk } from "../types";

export function BodyPage({
  chunk,
  reportTitle,
  dateText,
  companyName,
  logoBytes,
  images,
}: {
  chunk: BodyChunk;
  reportTitle: string;
  dateText: string;
  companyName: string;
  logoBytes: Buffer;
  images: Map<string, Buffer>;
}) {
  return (
    <Page size="LETTER" style={styles.page}>
      <Header title={reportTitle} dateText={dateText} />
      {chunk.isFirstOfSection ? (
        <>
          <Text style={styles.sectionHeader}>{chunk.sectionTitle}</Text>
          {chunk.sectionSummary ? (
            <Text style={styles.sectionSummary}>{chunk.sectionSummary}</Text>
          ) : null}
        </>
      ) : null}
      {chunk.photos.length > 0 ? (
        <View style={styles.grid}>
          {chunk.photos.map((p) => (
            <PhotoCell
              key={p.id}
              buffer={p.s3Key ? images.get(p.s3Key) : undefined}
              caption={p.caption}
              description={p.description}
              timestamp={p.timestamp ?? null}
            />
          ))}
        </View>
      ) : null}
      <Footer companyName={companyName} logoBytes={logoBytes} />
    </Page>
  );
}
