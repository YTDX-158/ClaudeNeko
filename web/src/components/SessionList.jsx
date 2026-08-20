import SessionItem from './SessionItem.jsx';

export default function SessionList({ sessions, activeId, onSelect, onRemove, onRename }) {
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
        />
      ))}
    </ul>
  );
}
