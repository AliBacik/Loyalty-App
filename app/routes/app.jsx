import { Link, Outlet, useLoaderData, useRouteError, useNavigation, useNavigate } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import dashboardStyles from "../styles/dashboard.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: dashboardStyles },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function NavSpinnerLink({ to, children, rel }) {
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isLoading = navigation.state !== "idle" && navigation.location?.pathname === to;

  return (
    <Link
      to={to}
      rel={rel}
      onClick={(e) => { e.preventDefault(); navigate(to); }}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      {isLoading && (
        <span style={{
          display: "inline-block", width: 10, height: 10,
          border: "2px solid currentColor", borderTopColor: "transparent",
          borderRadius: "50%", animation: "spin 0.7s linear infinite",
        }} />
      )}
      {children}
    </Link>
  );
}

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <NavMenu>
        <NavSpinnerLink to="/app" rel="home">Home</NavSpinnerLink>
        <NavSpinnerLink to="/app/analytics">Analytics</NavSpinnerLink>
        <NavSpinnerLink to="/app/wishlist-analytics">Wishlist Analytics</NavSpinnerLink>
        <NavSpinnerLink to="/app/birthday-customers">Birthday Customers</NavSpinnerLink>
        <NavSpinnerLink to="/app/tools">Tools</NavSpinnerLink>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
