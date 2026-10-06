package com.arpi.odoo.workentry;

import com.arpi.odoo.workentry.WorkEntryRecordParser.Rec;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.util.indexing.FileBasedIndex;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Lookup of work entry types by code, shared by the inlay hints and the navigation. */
public final class WorkEntryTypes {

    private static final Pattern L10N_PATH = Pattern.compile("/l10n_([a-z]{2})_");
    private static final Pattern STRING_LITERAL = Pattern.compile("^[rRbBuU]{0,2}(['\"])(.+)\\1$");

    private WorkEntryTypes() {
    }

    /** A record together with the file it lives in, the name resolved through overrides. */
    public record Entry(Rec rec, VirtualFile file, String name, String renamedBy) {
        public String countryLabel() {
            return rec.country == null ? "Generic" : rec.country;
        }
    }

    /**
     * Returns the code literal under the given leaf if it is a string literal (Python) or XML text/attribute
     * value, null otherwise.
     */
    public static String codeLiteral(PsiElement leaf) {
        if (leaf == null || leaf.getFirstChild() != null) {
            return null;
        }
        String type = leaf.getNode().getElementType().toString();
        String text = leaf.getText();
        if (type.equals("XML_DATA_CHARACTERS") || type.equals("XML_ATTRIBUTE_VALUE_TOKEN")) {
            return text.trim();
        }
        if (type.contains("STRING")) {
            Matcher m = STRING_LITERAL.matcher(text);
            if (m.matches()) {
                return m.group(2);
            }
        }
        return null;
    }

    /** Upper-case country code derived from an l10n_xx_* module path, null if none. */
    public static String preferredCountry(PsiFile file) {
        VirtualFile vf = file == null ? null : file.getOriginalFile().getVirtualFile();
        if (vf == null) {
            return null;
        }
        Matcher m = L10N_PATH.matcher(vf.getPath());
        return m.find() ? m.group(1).toUpperCase() : null;
    }

    public static List<Entry> find(Project project, String code, String preferredCountry) {
        if (code == null || code.isEmpty() || code.length() > 64 || code.startsWith(WorkEntryTypeIndex.OVERRIDE_PREFIX)) {
            return List.of();
        }
        FileBasedIndex index = FileBasedIndex.getInstance();
        GlobalSearchScope scope = GlobalSearchScope.allScope(project);
        Map<String, Entry> byXmlid = new LinkedHashMap<>();
        index.processValues(WorkEntryTypeIndex.NAME, code, null, (file, recs) -> {
            for (Rec rec : recs) {
                byXmlid.putIfAbsent(rec.xmlid, new Entry(rec, file, rec.name, null));
            }
            return true;
        }, scope);
        List<Entry> result = new ArrayList<>();
        for (Entry entry : byXmlid.values()) {
            Entry[] renamed = {entry};
            index.processValues(WorkEntryTypeIndex.NAME, WorkEntryTypeIndex.OVERRIDE_PREFIX + entry.rec().xmlid, null,
                    (file, recs) -> {
                        for (Rec rec : recs) {
                            renamed[0] = new Entry(entry.rec(), entry.file(), rec.name, moduleOf(file));
                        }
                        return true;
                    }, scope);
            result.add(renamed[0]);
        }
        result.sort(Comparator
                .comparingInt((Entry e) -> rank(e, preferredCountry))
                .thenComparing(Entry::countryLabel));
        return result;
    }

    /**
     * The generic (country-less) record for the code, active ones first; falls back to the best ranked
     * country specific record when no generic one exists. Null if the code is unknown.
     */
    public static Entry findGeneric(Project project, String code) {
        List<Entry> entries = find(project, code, null);
        return entries.stream().filter(e -> e.rec().country == null).findFirst()
                .orElse(entries.isEmpty() ? null : entries.get(0));
    }

    /** Preferred country first, then generic records, then the rest; archived ones last. */
    private static int rank(Entry e, String preferredCountry) {
        int rank = preferredCountry != null && preferredCountry.equals(e.rec().country) ? 0 : e.rec().country == null ? 1 : 2;
        return e.rec().archived ? rank + 3 : rank;
    }

    private static String moduleOf(VirtualFile file) {
        for (VirtualFile dir = file.getParent(); dir != null; dir = dir.getParent()) {
            if (dir.findChild("__manifest__.py") != null) {
                return dir.getName();
            }
        }
        return file.getName();
    }
}
