import SessionItem from './SessionItem.jsx';

export default function SessionList({
  sessions,
  activeId,
  onSelect,
  onRemove,
  onRename,
  onTogglePin,
  manageMode = false,
  selected,
  onToggleSelected,
}) {
  return (
    <ul className="session-list" role="list">
      {sessions.map((s) => (
        <SessionItem
          key={s.id}
          session={s}
          active={s.id === activeId}
          onSelect={onSelect}
          onRemove={onRemove}
          onRename={onRename}
          onTogglePin={onTogglePin}
          manageMode={manageMode}
          checked={selected?.has(s.id) ?? false}
          onToggleSelect={onToggleSelected}
        />
      ))}
    </ul>
  );
}
