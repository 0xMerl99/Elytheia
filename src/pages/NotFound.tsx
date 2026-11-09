import { Link } from 'react-router-dom';
import { LogoMark } from '../components/Brand';

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <div className="page empty-page">
      <LogoMark size={72} />
      <h2 style={{ marginTop: 18 }}>Nothing here</h2>
      <p className="muted">That {what} doesn't exist, or it moved.</p>
      <Link to="/home" className="btn gold">Back to home</Link>
    </div>
  );
}

export default NotFound;
