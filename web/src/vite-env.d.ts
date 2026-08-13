interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_AUTH0_DOMAIN: string;
  readonly VITE_AUTH0_CLIENT_ID: string;
  readonly VITE_AUTH0_AUDIENCE: string;
  /** Optional: without it MapAnchorPicker falls back to its coordinate inputs. */
  readonly VITE_GOOGLE_MAPS_KEY?: string;
}
