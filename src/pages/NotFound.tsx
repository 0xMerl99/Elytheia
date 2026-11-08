import { Link } from 'react-router-dom';

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <div className="page empty-page">
      <h2>Lost at sea</h2>
      <p className="muted">That {what} doesn't exist, or it moved.</p>
      <Link to="/home" className="btn gold">Back to home</Link>
    </div>
  );
}

export default NotFound;
