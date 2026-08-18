import { Image, Page, Text, View } from "@react-pdf/renderer";
import { styles } from "./styles";
import type { CoverPageData } from "../types";
import { OverlayCorner } from "./OverlayCorner";
import { splitOverlayAddress } from "@shared/photoOverlay";

// Left-aligned letterhead cover: logo top-left, company name/address beneath,
// thin accent rule, large left-aligned title, full-width cover photo,
// meta block pinned bottom-left. Every coverConfig toggle behaves as before;
// with everything off, the page is just the title (plus description).
export function CoverPage({ data, images }: { data: CoverPageData; images: Map<string, Buffer> }) {
  const logoBuf = data.companyLogoKey ? images.get(data.companyLogoKey) : undefined;
  const coverBuf = data.coverPhotoKey ? images.get(data.coverPhotoKey) : undefined;

  const showLogo = data.toggles.showCompanyLogo && !!logoBuf;
  const showName = data.toggles.showCompanyName && !!data.companyDisplayName;
  const showAddress = data.toggles.showCompanyName && !!data.companyAddress;
  const hasHeaderBlock = showLogo || showName || showAddress;

  const showCreator = data.toggles.showCreatorName && !!data.creatorName;
  const showDate = data.toggles.showDateCreated;
  const showCount = data.toggles.showPhotoCount;
  const hasMetaBlock = showCreator || showDate || showCount;

  return (
    <Page size="LETTER" style={styles.coverPage}>
      {showLogo && <Image style={styles.letterheadLogo} src={logoBuf!} />}
      {showName && <Text style={styles.companyName}>{data.companyDisplayName}</Text>}
      {showAddress && <Text style={styles.companyAddress}>{data.companyAddress}</Text>}

      {hasHeaderBlock && <View style={styles.coverRule} />}

      <Text style={styles.coverTitle}>{data.title || "Untitled Report"}</Text>
      {data.description ? <Text style={styles.coverDescription}>{data.description}</Text> : null}

      {data.toggles.showCoverPhoto && coverBuf ? (
        <View style={styles.coverPhotoBox}>
          <Image style={styles.coverPhoto} src={coverBuf} />
          {data.overlay && (data.overlay.timestamp || data.overlay.address) ? (
            <OverlayCorner
              large
              lines={[
                ...(data.overlay.timestamp ? [data.overlay.timestamp] : []),
                ...splitOverlayAddress(data.overlay.address),
              ]}
            />
          ) : null}
        </View>
      ) : null}

      {hasMetaBlock && (
        <View style={styles.coverMeta}>
          {showCreator && <Text style={styles.coverMetaLine}>Prepared by: {data.creatorName}</Text>}
          {showDate && <Text style={styles.coverMetaLine}>Date: {data.dateText}</Text>}
          {showCount && <Text style={styles.coverMetaLine}>Photos: {data.photoCount}</Text>}
        </View>
      )}
    </Page>
  );
}
