import { Image, Text, View } from "@react-pdf/renderer";
import { styles } from "./styles";

export function PhotoCell({
  buffer,
  caption,
  description,
}: {
  buffer: Buffer | undefined;
  caption: string | null;
  description: string | null;
}) {
  return (
    <View style={styles.cell} wrap={false}>
      <View style={styles.cellPhotoBox}>
        {buffer ? (
          <Image style={styles.cellPhoto} src={buffer} />
        ) : (
          <View style={styles.cellPhotoMissing} />
        )}
      </View>
      {caption ? <Text style={styles.cellCaption}>{caption}</Text> : null}
      {description ? <Text style={styles.cellDescription}>{description}</Text> : null}
    </View>
  );
}
