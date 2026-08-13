import type {AnchorHTMLAttributes} from 'react';
import {Link, Outlet, useLocation, useNavigate} from 'react-router';
import {useAuth0} from '@auth0/auth0-react';
import {AppShell} from '@astryxdesign/core/AppShell';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {HStack} from '@astryxdesign/core/Layout';
import {LinkProvider} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {SideNav, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {TopNav, TopNavHeading} from '@astryxdesign/core/TopNav';
import {useEmployer} from '../lib/employer';

const NAV_ITEMS = [
  {label: 'Calendar', href: '/calendar'},
  {label: 'Table', href: '/table'},
  {label: 'Employees', href: '/employees'},
  {label: 'Settings', href: '/settings'},
];

// Employer ids are UUIDs, so this can never collide with a real option value.
const NEW_EMPLOYER = 'new-employer';

// Astryx renders every href through the LinkProvider component, so this one adapter
// keeps the whole shell on client-side navigation.
function RouterLink({href, ...props}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <Link to={href ?? '/'} {...props} />;
}

/** Named Shell, not AppShell: the file name comes from design §6.1, but the Astryx
 * component it wraps already owns that name. */
export function Shell() {
  const {pathname} = useLocation();
  const navigate = useNavigate();
  const {user, logout} = useAuth0();
  const {employers, employer, setEmployerId} = useEmployer();

  return (
    <LinkProvider component={RouterLink}>
      <AppShell
        contentPadding={4}
        topNav={
          <TopNav
            heading={<TopNavHeading heading="ClockIt" headingHref="/calendar" />}
            endContent={
              <HStack gap={2} vAlign="center">
                {/* ponytail: a lone employer has nothing to switch to, so the switcher —
                    and with it the only link to /onboarding — is hidden, per plan §3.1.
                    Task 6 can put a "New employer" action in Settings if it is wanted. */}
                {employers.length > 1 && (
                  <Selector
                    label="Employer"
                    isLabelHidden
                    variant="ghost"
                    value={employer?.id}
                    options={[
                      ...employers.map((e) => ({value: e.id, label: e.name})),
                      {type: 'divider' as const},
                      {value: NEW_EMPLOYER, label: 'New employer'},
                    ]}
                    onChange={(value) => {
                      // Never stored as the active employer: it is an action, not a value.
                      if (value === NEW_EMPLOYER) void navigate('/onboarding');
                      else setEmployerId(value);
                    }}
                  />
                )}
                <DropdownMenu
                  button={{label: user?.email ?? 'Account', variant: 'ghost'}}
                  alignment="end"
                  items={[
                    {
                      label: 'Sign out',
                      onClick: () =>
                        logout({logoutParams: {returnTo: window.location.origin}}),
                    },
                  ]}
                />
              </HStack>
            }
          />
        }
        sideNav={
          <SideNav>
            <SideNavSection title="Navigation" isHeaderHidden>
              {NAV_ITEMS.map((item) => (
                <SideNavItem
                  key={item.href}
                  label={item.label}
                  href={item.href}
                  isSelected={pathname === item.href}
                />
              ))}
            </SideNavSection>
          </SideNav>
        }>
        <Outlet />
      </AppShell>
    </LinkProvider>
  );
}
