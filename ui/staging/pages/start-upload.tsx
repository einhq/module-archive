import { Button } from '@mantine/core';
import { useNavigate } from 'react-router-dom';

/**
 * The home page's way to begin while its News is empty (a `home.start` panel, for the signed in):
 * a button that opens Staging, where pictures are uploaded.
 */
export default function StartUpload() {
  const navigate = useNavigate();
  return <Button variant='light' onClick={() => navigate('/staging')}>Upload</Button>;
}
