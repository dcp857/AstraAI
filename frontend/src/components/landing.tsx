"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";

export function Landing() {
  return <main className="landing-page">
    <header className="landing-nav">
      <Link className="brand-lockup" href="/" aria-label="Astra home"><span className="brand-mark">✳</span><span>astra</span></Link>
      <nav aria-label="Main navigation"><a href="#how-it-helps">Why Astra</a><Link href="/login">Sign in</Link><Link className="landing-nav-cta" href="/register">Create account <span>↗</span></Link><ThemeToggle className="landing-theme"/></nav>
    </header>
    <section className="landing-hero">
      <div className="landing-copy">
        <p className="landing-kicker"><span/> A quieter place for bigger thoughts</p>
        <h1>Make room<br/>for <em>what’s next.</em></h1>
        <p className="landing-lede">Astra helps you think clearly, work through the hard parts, and turn a first thought into something real.</p>
        <div className="landing-actions"><Link className="landing-primary" href="/register">Get started <span>↗</span></Link><Link className="landing-secondary" href="/login">I already have an account</Link></div>
        <p className="landing-privacy"><span>✳</span> Your conversations stay in your private workspace.</p>
      </div>
      <div className="landing-art" aria-label="Preview of an Astra conversation">
        <div className="art-orbit orbit-a"/><div className="art-orbit orbit-b"/>
        <div className="preview-window"><div className="preview-bar"><div className="brand-mark">✳</div><span>New conversation</span><span className="preview-dots">•••</span></div>
          <div className="preview-content"><div className="preview-day">A moment to think</div><div className="preview-user">I have an idea, but I’m not sure where to begin.</div>
            <div className="preview-answer"><div className="preview-spark">✳</div><div><p>That’s a good place to start. What part feels most exciting to you?</p><div className="preview-lines"><i/><i/><i/></div></div></div>
            <div className="preview-input"><span>Write your next thought…</span><b>↑</b></div>
          </div>
        </div>
        <div className="art-note"><span>✦</span><div><strong>One thought at a time</strong><small>Ideas, questions, and everything between</small></div></div>
      </div>
    </section>
    <section className="landing-benefits" id="how-it-helps"><div><span className="benefit-mark">01</span><h2>Think it through</h2><p>Get a fresh perspective when a decision, idea, or question needs room to breathe.</p></div><div><span className="benefit-mark">02</span><h2>Make something</h2><p>Work through code, writing, plans, and the small steps that move a project forward.</p></div><div><span className="benefit-mark">03</span><h2>Pick up where you left off</h2><p>Your conversations stay organized in a private space, ready whenever you return.</p></div></section>
    <footer className="landing-footer"><span>✳ Astra</span><span>A thoughtful workspace for curious minds.</span><Link href="/register">Start a conversation ↗</Link></footer>
  </main>;
}
