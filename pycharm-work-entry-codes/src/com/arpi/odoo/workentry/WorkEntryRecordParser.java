package com.arpi.odoo.workentry;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Regex based extraction of hr.work.entry.type records from an Odoo data file.
 * Kept free of any IntelliJ dependency so it can be exercised standalone.
 */
public final class WorkEntryRecordParser {

    public static final String MODEL = "hr.work.entry.type";

    private static final Pattern COMMENT = Pattern.compile("<!--.*?-->", Pattern.DOTALL);
    private static final Pattern RECORD = Pattern.compile("<record\\b([^>]*?)(/?)>", Pattern.DOTALL);
    private static final Pattern RECORD_END = Pattern.compile("</record\\s*>");
    private static final Pattern FIELD = Pattern.compile(
            "<field\\s+name=[\"'](\\w+)[\"']([^>]*?)(?:/>|>(.*?)</field\\s*>)", Pattern.DOTALL);
    private static final Pattern REF_ATTR = Pattern.compile("\\bref=[\"']([^\"']+)[\"']");
    private static final Pattern EVAL_ATTR = Pattern.compile("\\beval=[\"']([^\"']+)[\"']");
    private static final Pattern EVAL_REF = Pattern.compile("ref\\(\\s*[\"']([^\"']+)[\"']\\s*\\)");

    private WorkEntryRecordParser() {
    }

    public static final class Rec {
        /** Fully qualified xmlid (module.name). */
        public final String xmlid;
        /** Null for override records that do not (re)define the code. */
        public final String code;
        public final String name;
        public final String displayCode;
        /** Upper-case ISO code, null for generic records. */
        public final String country;
        public final boolean archived;
        /** Offset of the {@code <record} tag in the file. */
        public final int offset;

        public Rec(String xmlid, String code, String name, String displayCode, String country, boolean archived, int offset) {
            this.xmlid = xmlid;
            this.code = code;
            this.name = name;
            this.displayCode = displayCode;
            this.country = country;
            this.archived = archived;
            this.offset = offset;
        }

        @Override
        public String toString() {
            return xmlid + " [" + code + "] " + name + " (" + (country == null ? "generic" : country) + ")"
                    + (archived ? " archived" : "") + " @" + offset;
        }
    }

    public static List<Rec> parse(CharSequence content, String module) {
        List<Rec> result = new ArrayList<>();
        String text = content.toString();
        if (!text.contains(MODEL)) {
            return result;
        }
        text = blankComments(text);
        Matcher record = RECORD.matcher(text);
        Matcher end = RECORD_END.matcher(text);
        int from = 0;
        while (record.find(from)) {
            String attrs = record.group(1);
            boolean selfClosing = !record.group(2).isEmpty();
            int bodyStart = record.end();
            int bodyEnd = bodyStart;
            if (!selfClosing) {
                if (!end.find(bodyStart)) {
                    break;
                }
                bodyEnd = end.start();
            }
            from = selfClosing ? bodyStart : end.end();
            if (!MODEL.equals(attr(attrs, "model"))) {
                continue;
            }
            String id = attr(attrs, "id");
            if (id == null) {
                continue;
            }
            String xmlid = id.contains(".") ? id : module + "." + id;
            String code = null, name = null, displayCode = null, country = null;
            boolean archived = false;
            Matcher field = FIELD.matcher(text).region(bodyStart, bodyEnd);
            while (field.find()) {
                String fname = field.group(1);
                String fattrs = field.group(2);
                String value = field.group(3) == null ? null : unescape(field.group(3).trim());
                switch (fname) {
                    case "code" -> code = value;
                    case "name" -> name = value;
                    case "display_code" -> displayCode = value;
                    case "country_id" -> country = countryOf(fattrs);
                    case "active" -> archived = isFalse(fattrs, value);
                    default -> {
                    }
                }
            }
            result.add(new Rec(xmlid, emptyToNull(code), emptyToNull(name), emptyToNull(displayCode), country, archived,
                    record.start()));
        }
        return result;
    }

    private static String blankComments(String text) {
        Matcher m = COMMENT.matcher(text);
        if (!m.find()) {
            return text;
        }
        StringBuilder sb = new StringBuilder(text);
        do {
            for (int i = m.start(); i < m.end(); i++) {
                if (sb.charAt(i) != '\n') {
                    sb.setCharAt(i, ' ');
                }
            }
        } while (m.find());
        return sb.toString();
    }

    private static String attr(String attrs, String name) {
        Matcher m = Pattern.compile("\\b" + name + "=[\"']([^\"']*)[\"']").matcher(attrs);
        return m.find() ? m.group(1) : null;
    }

    private static String countryOf(String fattrs) {
        String ref = null;
        Matcher m = REF_ATTR.matcher(fattrs);
        if (m.find()) {
            ref = m.group(1);
        } else {
            Matcher e = EVAL_ATTR.matcher(fattrs);
            if (e.find()) {
                Matcher r = EVAL_REF.matcher(e.group(1));
                if (r.find()) {
                    ref = r.group(1);
                }
            }
        }
        if (ref == null) {
            return null;
        }
        String local = ref.substring(ref.indexOf('.') + 1);
        return local.toUpperCase();
    }

    private static boolean isFalse(String fattrs, String value) {
        Matcher e = EVAL_ATTR.matcher(fattrs);
        String v = e.find() ? e.group(1) : value;
        return v != null && (v.trim().equals("False") || v.trim().equals("0"));
    }

    private static String emptyToNull(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    private static String unescape(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
                .replace("&apos;", "'").replace("&amp;", "&");
    }
}
