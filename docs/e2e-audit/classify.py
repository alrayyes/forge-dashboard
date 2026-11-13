# Regenerates spec-classes.csv. Usage: python3 docs/e2e-audit/classify.py . docs/e2e-audit/spec-classes.csv
import json,re,glob,os,csv,sys
root=sys.argv[1]
dur=json.load(open(f'{root}/tests/e2e-durations.json'))
BROWSER=re.compile(r'toHaveCSS|getComputedStyle|boundingBox|\.focus\(|keyboard\.|\.press\(|AxeBuilder|axe|forcedColors|forced-colors|setViewportSize|\.hover\(|toBeFocused|toBeInViewport|scrollIntoView|scrollTo|emulateMedia|evaluate\(|offsetWidth|clientWidth|scrollWidth|reducedMotion|toHaveScreenshot|viewport')
lib={os.path.basename(p)[:-8] for p in glob.glob(f'{root}/web/src/lib/*.test.ts')}
gotests=[os.path.basename(p) for p in glob.glob(f'{root}/internal/**/*_test.go',recursive=True)]
gostems={g[:-8].replace('_','-') for g in gotests}
Bset={'settings-field-errors','filter-persistence','main-branches-server-copy','filter-late-copy'}
Aset={'mono-figures'}  # assertions live in a helper the token scan cannot see
Dset={'filter-save-order':'web/src/lib/filters-save-order.test.ts','filter-mixed-case':'web/src/lib/filters-mixed-case.test.ts'}
rows=[]
for p in sorted(glob.glob(f'{root}/tests/*.spec.ts')):
    n=os.path.basename(p); stem=n[:-8]
    src=open(p).read()
    parts=re.split(r'\n\s*test(?:\.(?:skip|fixme))?\(',src)[1:]
    nt=len(parts)
    nb=sum(1 for t in parts if BROWSER.search(t))
    d=dur.get(n)
    lowers=[f'web/src/lib/{l}.test.ts' for l in sorted(lib) if l==stem or stem.startswith(l+'-') or l.startswith(stem)]
    if stem in Dset: cls='D'; lowers=[Dset[stem]]
    elif stem in Bset: cls='B'
    elif stem in Aset or (nt and nb/nt>=0.5): cls='A'
    else: cls='C'
    movable=0.0
    if d and nt: movable=d*(nt-nb)/nt
    rows.append(dict(spec=n,duration_s=d if d is not None else '',tests=nt,browser_only_tests=nb,cls=cls,lower=';'.join(lowers),est_movable_s=round(movable,1)))
w=csv.DictWriter(open(sys.argv[2],'w',newline=''),fieldnames=list(rows[0]))
w.writeheader();w.writerows(rows)
import collections
agg=collections.defaultdict(lambda:[0,0.0])
for r in rows:
    agg[r['cls']][0]+=1; agg[r['cls']][1]+=r['duration_s'] or 0
print(dict(agg),len(rows),sum(r['tests'] for r in rows))
