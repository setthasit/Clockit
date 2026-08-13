import type {AnchorHTMLAttributes} from 'react';
import {Link, Outlet, useLocation} from 'react-router';
import {useAuth0} from '@auth0/auth0-react';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Avatar} from '@astryxdesign/core/Avatar';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {LinkProvider} from '@astryxdesign/core/Link';
import {NavHeadingMenu, NavHeadingMenuItem} from '@astryxdesign/core/NavMenu';
import {SideNav, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {TopNav, TopNavHeading} from '@astryxdesign/core/TopNav';
import {useActiveEmployer, useEmployer} from '../lib/employer';

const NAV_ITEMS = [
  {label: 'Calendar', href: '/calendar'},
  {label: 'Table', href: '/table'},
  {label: 'Employees', href: '/employees'},
  {label: 'Settings', href: '/settings'},
];

// Astryx renders every href through the LinkProvider component, so this one adapter
// keeps the whole shell on client-side navigation.
function RouterLink({href, ...props}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <Link to={href ?? '/'} {...props} />;
}

/** Named Shell, not AppShell: the file name comes from design §6.1, but the Astryx
 * component it wraps already owns that name. */
export function Shell() {
  const {pathname} = useLocation();
  const {user, logout} = useAuth0();
  const {employers, setEmployerId} = useEmployer();
  const employer = useActiveEmployer();

  return (
    <LinkProvider component={RouterLink}>
      <AppShell
        contentPadding={4}
        topNav={
          <TopNav
            heading={
              // The heading menu is Astryx's documented product-switcher pattern; a
              // Selector would announce "New employer" as a selectable value in a listbox
              // rather than the link it is. Shown at any employer count, so a single
              // employer account can still reach /onboarding.
              <TopNavHeading
                heading="ClockIt"
                headingHref="/calendar"
                subheading={employer.name}
                menu={
                  <NavHeadingMenu>
                    {employers.map((e) => (
                      <NavHeadingMenuItem
                        key={e.id}
                        label={e.name}
                        onClick={() => setEmployerId(e.id)}
                      />
                    ))}
                    <NavHeadingMenuItem label="New employer" href="/onboarding" />
                  </NavHeadingMenu>
                }
              />
            }
            endContent={
              <DropdownMenu
                button={{
                  label: user?.email ?? 'Account',
                  variant: 'ghost',
                  icon: (
                    // tooltip={false}: the button's own label already names the account,
                    // and the avatar's default tooltip would cover the open menu.
                    <Avatar
                      src={user?.picture}
                      name={user?.name ?? user?.email}
                      size="sm"
                      tooltip={false}
                    />
                  ),
                }}
                alignment="end"
                items={[
                  {
                    label: 'Sign out',
                    onClick: () =>
                      logout({logoutParams: {returnTo: window.location.origin}}),
                  },
                ]}
              />
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
