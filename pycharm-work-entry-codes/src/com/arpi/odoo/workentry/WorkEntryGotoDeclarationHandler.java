package com.arpi.odoo.workentry;

import com.arpi.odoo.workentry.WorkEntryTypes.Entry;
import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler;
import com.intellij.icons.AllIcons;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.project.DumbService;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiManager;
import com.intellij.psi.impl.FakePsiElement;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.Icon;

/** Ctrl+click on a work entry type code literal jumps to its {@code <record>}. */
public final class WorkEntryGotoDeclarationHandler implements GotoDeclarationHandler {

    @Override
    public PsiElement @Nullable [] getGotoDeclarationTargets(@Nullable PsiElement source, int offset, Editor editor) {
        if (source == null || DumbService.isDumb(source.getProject())) {
            return null;
        }
        String code = WorkEntryTypes.codeLiteral(source);
        if (code == null) {
            return null;
        }
        Entry entry = WorkEntryTypes.findGeneric(source.getProject(), code);
        if (entry == null) {
            return null;
        }
        PsiFile xml = PsiManager.getInstance(source.getProject()).findFile(entry.file());
        return xml == null ? null : new PsiElement[]{new RecordElement(xml, entry)};
    }

    private static final class RecordElement extends FakePsiElement {
        private final PsiFile file;
        private final Entry entry;

        RecordElement(PsiFile file, Entry entry) {
            this.file = file;
            this.entry = entry;
        }

        @Override
        public PsiElement getParent() {
            return file;
        }

        @Override
        public PsiFile getContainingFile() {
            return file;
        }

        @Override
        public int getTextOffset() {
            return entry.rec().offset;
        }

        @Override
        public @NotNull PsiElement getNavigationElement() {
            PsiElement element = file.findElementAt(entry.rec().offset);
            return element != null && element.getParent() != null ? element.getParent() : file;
        }

        @Override
        public String getName() {
            return entry.name() == null ? entry.rec().xmlid : entry.name();
        }

        @Override
        public @Nullable String getPresentableText() {
            return getName() + " — " + entry.countryLabel() + (entry.rec().archived ? " (archived)" : "");
        }

        @Override
        public @Nullable String getLocationString() {
            return entry.rec().xmlid;
        }

        @Override
        public @Nullable Icon getIcon(boolean open) {
            return AllIcons.Nodes.DataTables;
        }

        @Override
        public boolean canNavigate() {
            return true;
        }

        @Override
        public void navigate(boolean requestFocus) {
            new OpenFileDescriptor(file.getProject(), entry.file(), entry.rec().offset).navigate(requestFocus);
        }
    }
}
