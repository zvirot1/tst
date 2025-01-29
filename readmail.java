
import javax.mail.*;

import java.io.*;
import java.io.InputStream;
import java.util.*;

public class readmail {
	public static void main(String[] args) throws Exception {
		Store s = Session.getInstance(System.getProperties(), null).getStore(
				"pop3");
		s.connect("mail.bezeqint.net", "zvirt", "mchruy");
		//System.out.println("s.getDefaultFolder() " +s.getDefaultFolder());
		Folder f = s.getFolder("inbox");
		
		f.open(Folder.READ_ONLY);
		System.out.println(f.getName());
		Message[] ml =  f.getMessages();
		System.out.println(ml.length);
		Message m = ml[22];

		if (m.getContent() instanceof Multipart)
			System.out.println("instanceof 'Multipart'");
		else
			System.out.println("m.getContent instanceof 'Part'");
		Multipart mp = (Multipart) m.getContent();
		System.out.println("mp.getCount()=" + mp.getCount());
		System.out.println("Subject=" + m.getSubject());
		System.out.println("ContentType=" + m.getContentType());
		System.out.println("m.getFileName() = " + m.getFileName());
		//System.out.println(m );
		
		
		
		List<File> attachments = new ArrayList<File>();
		for (int i = 0; i < mp.getCount(); i++) 
		{         BodyPart bodyPart = mp.getBodyPart(i);   
		if(!Part.ATTACHMENT.equalsIgnoreCase(bodyPart.getDisposition())) 
		{          
			continue;
		}
		// dealing with attachments only         }     
		InputStream is = bodyPart.getInputStream();    
		File file = new File("d:\\" + bodyPart.getFileName());    
		FileOutputStream fos = new FileOutputStream(file);    
		byte[] buf = new byte[4096];       
		int bytesRead;        
		while((bytesRead = is.read(buf))!=-1) {          
		fos.write(buf, 0, bytesRead);         }    
		fos.close();        
		attachments.add(file);     } 
		}
		
		//InputStream is = mp.getBodyPart(0).getInputStream();

		//StringBuffer sb = new StringBuffer();
		//byte[] b = new byte[100000];
		//int noChars = is.read(b);
		
		
		//sb.append(new String(b, 0, noChars));
		//System.out.println("MessageContent=" + sb.toString());
		
		
		
		
		

	/*	
		List<File> attachments = new ArrayList<File>();
		for (Message message : temp)
		{     Multipart multipart = (Multipart) message.getContent();    
		// System.out.println(multipart.getCount());     
		for (int i = 0; i < multipart.getCount(); i++) 
		{         BodyPart bodyPart = multipart.getBodyPart(i);   
		if(!Part.ATTACHMENT.equalsIgnoreCase(bodyPart.getDisposition())) 
		{           continue; 
		// dealing with attachments only         }     
		InputStream is = bodyPart.getInputStream();    
		File file = new File("/tmp/" + bodyPart.getFileName());    
		FileOutputStream fos = new FileOutputStream(file);    
		byte[] buf = new byte[4096];       
		int bytesRead;        
		while((bytesRead = is.read(buf))!=-1) {          
		fos.write(buf, 0, bytesRead);         }    
		fos.close();        
		attachments.add(file);     } 
		}
		*/
		//f.close(false);
		//s.close();
	}

