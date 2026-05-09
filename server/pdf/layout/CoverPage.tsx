import { Image, Page, Text, View } from "@react-pdf/renderer";
import { styles } from "./styles";
import type { CoverPageData } from "../types";

export function CoverPage({ data, images }: { data: CoverPageData; images: Map<string, Buffer> }) {
  const logoBuf = data.companyLogoKey ? images.get(data.companyLogoKey) : undefined;
  const coverBuf = data.coverPhotoKey ? images.get(data.coverPhotoKey) : undefined;
  const showLetterhead =
    (data.toggles.showCompanyLogo && !!logoBuf) ||
    (data.toggles.showCompanyName && !!data.companyDisplayName);

  return (
    <Page size="LETTER" style={styles.coverPage}>
      {showLetterhead && (
        <View style={styles.letterhead}>
          {data.toggles.showCompanyLogo && logoBuf ? (
            <Image style={styles.letterheadLogo} src={logoBuf} />
          ) : null}
          <View style={styles.letterheadText}>
            {data.toggles.showCompanyName && data.companyDisplayName ? (
              <Text style={styles.companyName}>{data.companyDisplayName}</Text>
            ) : null}
            {data.companyAddress ? (
              <Text style={styles.companyAddress}>{data.companyAddress}</Text>
            ) : null}
          </View>
        </View>
      )}

      <Text style={styles.coverTitle}>{data.title || "Untitled Report"}</Text>
      {data.description ? <Text style={styles.coverDescription}>{data.description}</Text> : null}

      {data.toggles.showCoverPhoto && coverBuf ? (
        <View style={styles.coverPhotoBox}>
          <Image style={styles.coverPhoto} src={coverBuf} />
        </View>
      ) : null}

      <View style={styles.coverMeta}>
        {data.toggles.showCreatorName && data.creatorName ? (
          <Text style={styles.coverMetaLine}>Prepared by: {data.creatorName}</Text>
        ) : null}
        {data.toggles.showDateCreated ? (
          <Text style={styles.coverMetaLine}>Date: {data.dateText}</Text>
        ) : null}
        {data.toggles.showPhotoCount ? (
          <Text style={styles.coverMetaLine}>
            Photos: {data.photoCount}
          </Text>
        ) : null}
      </View>
    </Page>
  );
}
