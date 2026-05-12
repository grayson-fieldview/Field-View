import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";
import { Sentry } from "@/lib/sentry";
import faviconImg from "@assets/Favicon-01-brand_1778259672.png";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    try {
      Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } });
    } catch {
    }
    console.error("[ErrorBoundary] caught render error:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.assign("/");
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className="min-h-screen flex items-center justify-center bg-background px-4 py-8"
        data-testid="error-boundary-fallback"
      >
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-6 px-6 flex flex-col items-center text-center gap-5">
            <div className="flex items-center gap-2.5" data-testid="error-boundary-logo">
              <img src={faviconImg} alt="Field View" className="h-10 w-10 rounded-md" />
              <span className="text-xl font-bold tracking-tight text-foreground">Field View</span>
            </div>

            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-amber-100 dark:bg-amber-900/30">
              <AlertTriangle className="h-6 w-6 text-amber-700 dark:text-amber-400" aria-hidden="true" />
            </div>

            <div className="space-y-1.5">
              <h1 className="text-lg font-semibold text-foreground" data-testid="text-error-boundary-title">
                Something went wrong loading this page
              </h1>
              <p className="text-sm text-muted-foreground" data-testid="text-error-boundary-message">
                An unexpected error interrupted this view. Reloading usually fixes it.
              </p>
            </div>

            <Button
              onClick={this.handleReload}
              className="w-full"
              data-testid="button-error-boundary-reload"
            >
              Reload page
            </Button>

            <button
              type="button"
              onClick={this.handleGoHome}
              className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              data-testid="link-error-boundary-home"
            >
              Return to dashboard
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }
}

export default ErrorBoundary;
