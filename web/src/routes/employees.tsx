import {useEffect, useState} from 'react';
import {AlertDialog} from '@astryxdesign/core/AlertDialog';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Center} from '@astryxdesign/core/Center';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {HStack, Layout, LayoutContent, LayoutFooter, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Spinner} from '@astryxdesign/core/Spinner';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {pixel, proportional, Table, type TableColumn} from '@astryxdesign/core/Table';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {api, ApiError} from '../lib/api';
import {useActiveEmployer} from '../lib/employer';
import {cents, toCents} from '../lib/format';
import type {Member, MemberStatus} from '../lib/types';

const STATUS: Record<MemberStatus, {variant: 'accent' | 'success' | 'neutral'; label: string}> = {
  invited: {variant: 'accent', label: 'Invited'},
  active: {variant: 'success', label: 'Active'},
  removed: {variant: 'neutral', label: 'Removed'},
};

// Mirrors the backend's 100_000_000-cent ceiling so the stepper stops where the API does.
// The backend still validates: this only keeps the arrows from walking past it.
const MAX_RATE_DOLLARS = 1_000_000;

export function EmployeesRoute() {
  const employer = useActiveEmployer();

  // No employer tag on any of this state: Shell keys <Outlet/> by employer id, so a
  // switch remounts the route and clears all of it at once.
  const [loaded, setLoaded] = useState<Member[] | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{id: string; dollars: number | null} | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);

  const members = loaded === 'error' ? null : loaded;
  const loadFailed = loaded === 'error';

  useEffect(() => {
    let cancelled = false;

    api<{members: Member[]}>(`/v1/employers/${employer.id}/members`)
      .then((data) => {
        if (!cancelled) setLoaded(data.members);
      })
      .catch(() => {
        if (!cancelled) setLoaded('error');
      });

    return () => {
      cancelled = true;
    };
  }, [employer.id, attempt]);

  const updateMembers = (update: (list: Member[]) => Member[]) =>
    setLoaded((prev) => (prev && prev !== 'error' ? update(prev) : prev));

  const patchMember = (id: string, patch: Partial<Member>) =>
    updateMembers((list) => list.map((m) => (m.id === id ? {...m, ...patch} : m)));

  const commitRate = async (member: Member, dollars: number | null) => {
    const value = dollars === null ? null : toCents(dollars);
    // Opening the editor and leaving without a change is not a write.
    if (value === null || value === member.hourly_rate_cents) return;

    const previous = member.hourly_rate_cents;
    setError(null);
    patchMember(member.id, {hourly_rate_cents: value});

    try {
      await api<void>(`/v1/employers/${employer.id}/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({hourly_rate_cents: value}),
      });
    } catch {
      // A later edit to the same row may have landed while this was in flight; rolling
      // back then would overwrite a value the server has and this request never wrote.
      updateMembers((list) =>
        list.map((m) =>
          m.id === member.id && m.hourly_rate_cents === value
            ? {...m, hourly_rate_cents: previous}
            : m,
        ),
      );
      setError('Could not save that rate. Try again.');
    }
  };

  const removeMember = async (member: Member) => {
    setPendingRemoval(null);
    setError(null);
    patchMember(member.id, {status: 'removed'});

    try {
      await api<void>(`/v1/employers/${employer.id}/members/${member.id}`, {method: 'DELETE'});
    } catch {
      patchMember(member.id, {status: member.status});
      // A 404 here does not mean "already gone": ownership failures answer the same way.
      setError('Could not remove that employee. Try again.');
    }
  };

  // Serves both the add dialog and the Removed section: POSTing an address that already
  // has a removed membership revives that same membership, id included, so the response
  // either replaces a row in place or appends a new one.
  const invite = async (email: string) => {
    const {member} = await api<{member: Member}>(`/v1/employers/${employer.id}/members`, {
      method: 'POST',
      body: JSON.stringify({email}),
    });
    updateMembers((list) =>
      list.some((m) => m.id === member.id)
        ? list.map((m) => (m.id === member.id ? member : m))
        : [...list, member],
    );
  };

  const reinvite = async (member: Member) => {
    setError(null);
    try {
      await invite(member.email);
    } catch {
      // No backend message here: a re-invite address comes from the row, not from
      // something the user just typed, so "not found" or "too many requests" would be
      // wire diagnostics bannered over the page.
      setError('Could not re-invite that employee. Try again.');
    }
  };

  const renderRate = (member: Member) => {
    // A removed membership keeps its rate so past shifts still cost what they cost,
    // but there is nothing left to schedule, so the cell stops being editable.
    if (member.status === 'removed') {
      return (
        <Text type="body" color="secondary">
          {member.hourly_rate_cents === null ? 'Not set' : cents(member.hourly_rate_cents)}
        </Text>
      );
    }

    if (edit?.id === member.id) {
      return (
        <NumberInput
          label="Hourly rate"
          isLabelHidden
          size="sm"
          width={150}
          min={0}
          max={MAX_RATE_DOLLARS}
          step={0.25}
          placeholder="0.00"
          hasAutoFocus
          value={edit.dollars}
          onChange={(dollars) => setEdit({id: member.id, dollars})}
          onEnter={() => {
            void commitRate(member, edit.dollars);
            setEdit(null);
          }}
          // Escape is the way out of an inline money editor: closing without committing.
          // Unmounting a focused node fires no focusout, so onBlur does not run after it.
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEdit(null);
          }}
          onBlur={(e) => {
            // NumberInput reports no change when the field is emptied, so `edit.dollars`
            // still holds the last number typed. The event carries what is actually on
            // screen, and an empty field on the way out is a cancel, not a rate of that.
            if (e.target.value.trim() !== '') void commitRate(member, edit.dollars);
            setEdit(null);
          }}
        />
      );
    }

    return (
      <Button
        label={member.hourly_rate_cents === null ? 'Set rate' : cents(member.hourly_rate_cents)}
        variant="ghost"
        size="sm"
        onClick={() =>
          setEdit({
            id: member.id,
            // Dollars in the field, cents on the wire — see toCents() for the rounding.
            dollars: member.hourly_rate_cents === null ? null : member.hourly_rate_cents / 100,
          })
        }
      />
    );
  };

  const columns: TableColumn<Member>[] = [
    {
      key: 'name',
      header: 'Name',
      width: proportional(1),
      // Empty until the invitation is claimed: there is no user to take a name from yet.
      renderCell: (member) => <Text type="body">{member.name || '—'}</Text>,
    },
    {key: 'email', header: 'Email', width: proportional(2)},
    {
      key: 'status',
      header: 'Status',
      width: pixel(130),
      renderCell: (member) => (
        <HStack gap={2} vAlign="center">
          <StatusDot variant={STATUS[member.status].variant} label={STATUS[member.status].label} />
          <Text type="body">{STATUS[member.status].label}</Text>
        </HStack>
      ),
    },
    {
      key: 'hourly_rate_cents',
      header: (
        <VStack gap={0.5}>
          <Text type="inherit">Hourly rate</Text>
          <Text type="supporting" color="secondary">
            Rates are never visible to employees.
          </Text>
        </VStack>
      ),
      width: pixel(220),
      renderCell: renderRate,
    },
    {
      key: 'actions',
      header: '',
      width: pixel(130),
      align: 'end',
      resizable: false,
      renderCell: (member) => (
        <DropdownMenu
          button={{label: 'Actions', variant: 'ghost', size: 'sm'}}
          alignment="end"
          menuWidth={180}
          items={[
            member.status === 'removed'
              ? {label: 'Re-invite', onClick: () => void reinvite(member)}
              : {label: 'Remove', onClick: () => setPendingRemoval(member)},
          ]}
        />
      ),
    },
  ];

  const live = members?.filter((m) => m.status !== 'removed') ?? [];
  const removed = members?.filter((m) => m.status === 'removed') ?? [];

  return (
    // AppShell already insets the content region, and the tables run edge to edge inside
    // it, so this needs no surface of its own.
    <VStack gap={5}>
      <HStack gap={4} vAlign="center" hAlign="between">
        <VStack gap={1}>
          <Heading level={1}>Employees</Heading>
          <Text type="body" color="secondary">
            Invite your crew, set what each of them earns, and remove anyone who has left.
          </Text>
        </VStack>
        <Button label="Add employee" variant="primary" onClick={() => setIsAdding(true)} />
      </HStack>

      {error && <Banner status="error" title={error} />}

      {loadFailed && (
        <Banner
          status="error"
          title="Could not load your employees"
          description="Check your connection and try again."
          endContent={
            <Button
              label="Retry"
              variant="secondary"
              size="sm"
              // Back to the spinner: leaving the banner up until the retry resolves
              // reads as a dead button.
              onClick={() => {
                setLoaded(null);
                setAttempt((n) => n + 1);
              }}
            />
          }
        />
      )}

      {!loadFailed && !members && (
        <Center padding={10}>
          <Spinner size="lg" />
        </Center>
      )}

      {members?.length === 0 && (
        <EmptyState
          title="Add your first employee"
          description="Invite someone by email. They can clock in as soon as they sign in on their phone."
          actions={
            <Button label="Add employee" variant="primary" onClick={() => setIsAdding(true)} />
          }
        />
      )}

      {live.length > 0 && <Table data={live} columns={columns} idKey="id" hasHover />}

      {removed.length > 0 && (
        <VStack gap={2}>
          <Heading level={3}>Removed</Heading>
          <Table data={removed} columns={columns} idKey="id" />
        </VStack>
      )}

      {/* Both dialogs are native <dialog> in the top layer, so they take no space here. */}
      {isAdding && <AddEmployeeDialog onClose={() => setIsAdding(false)} onInvite={invite} />}

      {pendingRemoval && (
        <AlertDialog
          isOpen
          onOpenChange={() => setPendingRemoval(null)}
          title="Remove this employee?"
          description={`${pendingRemoval.name || pendingRemoval.email} stops being able to clock in. Past shifts stay on the record, and you can re-invite them from the Removed list.`}
          actionLabel="Remove"
          onAction={() => void removeMember(pendingRemoval)}
        />
      )}
    </VStack>
  );
}

function AddEmployeeDialog({
  onClose,
  onInvite,
}: {
  onClose: () => void;
  onInvite: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = email.trim();
    if (!value) {
      setError('Enter an email address.');
      return;
    }
    setError(null);

    try {
      await onInvite(value);
      onClose();
    } catch (e) {
      // ALREADY_MEMBER and a malformed address both belong on the field that caused
      // them, not on the page behind the dialog — and here the backend's own message
      // ("already a member of this employer") describes what the user just typed.
      setError(e instanceof ApiError ? e.message : 'Could not send that invitation. Try again.');
    }
  };

  return (
    <Dialog isOpen onOpenChange={onClose} width={440} purpose="form">
      <Layout
        header={<DialogHeader title="Add employee" onOpenChange={onClose} />}
        content={
          <LayoutContent>
            <TextInput
              type="email"
              label="Email"
              description="They see the invitation the first time they sign in."
              value={email}
              // Clear as they retype: an ALREADY_MEMBER hanging off the field they are
              // correcting reads as if the correction is wrong too.
              onChange={(value) => {
                setEmail(value);
                setError(null);
              }}
              placeholder="crew@example.com"
              hasAutoFocus
              isRequired
              status={error ? {type: 'error', message: error} : undefined}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Send invitation" variant="primary" clickAction={submit} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
