import { Image, Text, View } from "@react-pdf/renderer";
import { styles } from "./styles";

export function Footer({ companyName, logoBytes }: { companyName: string; logoBytes: Buffer }) {
  return (
    <View style={styles.footer} fixed>
      <Text style={styles.footerText}>{companyName}</Text>
      <Text
        style={styles.footerCenter}
        render={({ pageNumber, totalPages }) => `Page ${pageNumber - 1} of ${totalPages - 1}`}
      />
      <View style={styles.footerRight}>
        <Image style={styles.footerLogo} src={logoBytes} />
      </View>
    </View>
  );
}
