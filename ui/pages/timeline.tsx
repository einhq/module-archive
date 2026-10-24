import { Navigate, useLocation } from 'react-router-dom';

/** `/timeline` lands on the year view, so saved links and history still work. */
export default function TimelineRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/year${search}`} replace />;
}
