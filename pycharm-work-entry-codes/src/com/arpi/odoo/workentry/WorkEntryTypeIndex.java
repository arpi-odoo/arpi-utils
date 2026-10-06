package com.arpi.odoo.workentry;

import com.arpi.odoo.workentry.WorkEntryRecordParser.Rec;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.indexing.DataIndexer;
import com.intellij.util.indexing.FileBasedIndex;
import com.intellij.util.indexing.FileBasedIndexExtension;
import com.intellij.util.indexing.FileContent;
import com.intellij.util.indexing.ID;
import com.intellij.util.io.DataExternalizer;
import com.intellij.util.io.EnumeratorStringDescriptor;
import com.intellij.util.io.KeyDescriptor;
import org.jetbrains.annotations.NotNull;

import java.io.DataInput;
import java.io.DataOutput;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * code -> records defining that code.
 * "#" + xmlid -> override records (no code) that rename an existing work entry type.
 */
public final class WorkEntryTypeIndex extends FileBasedIndexExtension<String, List<Rec>> {

    public static final ID<String, List<Rec>> NAME = ID.create("arpi.odoo.work.entry.type.code");
    public static final String OVERRIDE_PREFIX = "#";

    @Override
    public @NotNull ID<String, List<Rec>> getName() {
        return NAME;
    }

    @Override
    public @NotNull DataIndexer<String, List<Rec>, FileContent> getIndexer() {
        return input -> {
            CharSequence text = input.getContentAsText();
            if (!text.toString().contains(WorkEntryRecordParser.MODEL)) {
                return Map.of();
            }
            Map<String, List<Rec>> map = new HashMap<>();
            for (Rec rec : WorkEntryRecordParser.parse(text, moduleOf(input.getFile()))) {
                String key = rec.code != null ? rec.code : rec.name != null ? OVERRIDE_PREFIX + rec.xmlid : null;
                if (key != null) {
                    map.computeIfAbsent(key, k -> new ArrayList<>()).add(rec);
                }
            }
            return map;
        };
    }

    private static String moduleOf(VirtualFile file) {
        for (VirtualFile dir = file.getParent(); dir != null; dir = dir.getParent()) {
            if (dir.findChild("__manifest__.py") != null) {
                return dir.getName();
            }
        }
        return "__unknown__";
    }

    @Override
    public @NotNull KeyDescriptor<String> getKeyDescriptor() {
        return EnumeratorStringDescriptor.INSTANCE;
    }

    @Override
    public @NotNull DataExternalizer<List<Rec>> getValueExternalizer() {
        return new DataExternalizer<>() {
            @Override
            public void save(@NotNull DataOutput out, List<Rec> recs) throws IOException {
                out.writeInt(recs.size());
                for (Rec r : recs) {
                    out.writeUTF(r.xmlid);
                    writeNullable(out, r.code);
                    writeNullable(out, r.name);
                    writeNullable(out, r.displayCode);
                    writeNullable(out, r.country);
                    out.writeBoolean(r.archived);
                    out.writeInt(r.offset);
                }
            }

            @Override
            public List<Rec> read(@NotNull DataInput in) throws IOException {
                int size = in.readInt();
                List<Rec> recs = new ArrayList<>(size);
                for (int i = 0; i < size; i++) {
                    recs.add(new Rec(in.readUTF(), readNullable(in), readNullable(in), readNullable(in),
                            readNullable(in), in.readBoolean(), in.readInt()));
                }
                return recs;
            }
        };
    }

    private static void writeNullable(DataOutput out, String s) throws IOException {
        out.writeBoolean(s != null);
        if (s != null) {
            out.writeUTF(s);
        }
    }

    private static String readNullable(DataInput in) throws IOException {
        return in.readBoolean() ? in.readUTF() : null;
    }

    @Override
    public int getVersion() {
        return 1;
    }

    @Override
    public @NotNull FileBasedIndex.InputFilter getInputFilter() {
        return file -> "xml".equalsIgnoreCase(file.getExtension());
    }

    @Override
    public boolean dependsOnFileContent() {
        return true;
    }
}
