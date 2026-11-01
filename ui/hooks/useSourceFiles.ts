import { useCallback, useEffect, useState } from 'react';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { SourceFile } from '@archive/sources/api';

/** The files the node at `path` was read from (`source-list`); none until `path` is known. */
export function useSourceFiles(path: string | undefined): { files: SourceFile[]; refetch: () => void } {
  const [files, setFiles] = useState<SourceFile[]>([]);

  const fetchFiles = useCallback(async () => {
    if (!path) {
      setFiles([]);
      return;
    }
    try {
      setFiles(await execCommand<SourceFile[]>(`source-list ${shq(path)}`));
    } catch {
      setFiles([]);
    }
  }, [path]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  return { files, refetch: fetchFiles };
}
