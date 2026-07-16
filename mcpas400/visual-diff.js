import { promises as fs } from 'fs';
import { join } from 'path';
export async function prepareVisualDiff(originalContent, fileName) {
    const amazonqDir = join(process.cwd(), '.amazonq');
    const tempFile = join(amazonqDir, `ibmi-temp-${fileName}`);
    await fs.mkdir(amazonqDir, { recursive: true });
    await fs.writeFile(tempFile, originalContent, 'utf-8');
    return tempFile;
}
//# sourceMappingURL=visual-diff.js.map
