import * as React from "react";
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

interface WelcomeEmailProps {
  firstName: string;
}

const main = {
  backgroundColor: "#ffffff",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  color: "#1a1a1a",
};

const container = {
  maxWidth: "560px",
  margin: "0 auto",
  padding: "40px 20px",
};

const wordmark = {
  fontSize: "18px",
  fontWeight: 700,
  color: "#1a1a1a",
  margin: "0 0 32px 0",
};

const paragraph = {
  fontSize: "16px",
  lineHeight: "1.6",
  color: "#1a1a1a",
  margin: "0 0 16px 0",
};

const listItem = {
  fontSize: "16px",
  lineHeight: "1.6",
  color: "#1a1a1a",
  margin: "0 0 12px 0",
};

const link = {
  color: "#F09000",
  textDecoration: "underline",
};

const hr = {
  border: "none",
  borderTop: "1px solid #e5e5e5",
  margin: "24px 0",
};

const signature = {
  fontSize: "14px",
  lineHeight: "1.6",
  color: "#1a1a1a",
  margin: "0 0 4px 0",
};

export default function WelcomeEmail({ firstName }: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>A note from the founder + how to get value in your first week</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={wordmark}>Field View</Text>

          <Section>
            <Text style={paragraph}>Hey {firstName},</Text>

            <Text style={paragraph}>
              Thanks for starting your Field View trial. I'm Grayson, the founder, and I wanted to personally welcome you in.
            </Text>

            <Text style={paragraph}>
              Quick context: I also run a painting company in South Florida, and Field View exists because I couldn't find a photo documentation tool that actually worked the way contractors work. Most of the tools out there are either too expensive, too complicated, or clearly built by people who've never been on a job site. We're trying to be the opposite.
            </Text>

            <Text style={paragraph}>
              A few things that'll help you get value quickly:
            </Text>

            <Text style={listItem}>
              <strong>1. Create your first project</strong> — Pick an active job and get it into the system. Takes about 30 seconds. The whole app is built around projects, so nothing else makes sense until you have one.
            </Text>

            <Text style={listItem}>
              <strong>2. Invite your crew</strong> — Field View gets 10x more useful when your team is uploading photos too. You can invite up to 3 users on your plan.
            </Text>

            <Text style={paragraph}>
              You've got 14 days to kick the tires. If it's not for you, cancel anytime before the trial ends and you won't be charged.
            </Text>

            <Text style={paragraph}>
              If you get stuck, hit reply to this email. I read every message.
            </Text>
          </Section>

          <Hr style={hr} />

          <Section>
            <Text style={signature}>Grayson</Text>
            <Text style={signature}>Founder, Field View</Text>
            <Text style={signature}>
              <Link href="mailto:grayson@field-view.com" style={link}>
                grayson@field-view.com
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
